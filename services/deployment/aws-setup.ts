/**
 * DWOMOH Vibe Code — AWS One-Time Setup Engine
 *
 * Automates the complete AWS configuration for the branded hosting system:
 *   1. Discover Route 53 hosted zone for dwomohvibe.app (created automatically when
 *      you purchase the domain through Route 53)
 *   2. Request a wildcard ACM certificate: *.dwomohvibe.app + dwomohvibe.app
 *   3. Auto-validate the certificate via Route 53 DNS records (takes 2–5 minutes)
 *   4. Create the Amplify IAM service role (required for SSR Next.js builds)
 *   5. Verify the domain in Amplify Hosting so CreateDomainAssociation works for all apps
 *   6. Persist all config to .env.local so every future deployment reuses it
 *
 * After this setup runs ONCE, every project deployment is fully automatic:
 *   deploy() → {slug}.dwomohvibe.app (SSL included, DNS auto-configured)
 */

import {
  Route53Client,
  ListHostedZonesByNameCommand,
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  CertificateStatus,
  ValidationMethod,
  type DomainValidation,
} from '@aws-sdk/client-acm';
import {
  AmplifyClient,
  CreateDomainAssociationCommand,
  GetDomainAssociationCommand,
  ListAppsCommand,
  CreateAppCommand,
  CreateBranchCommand,
  Platform,
  Stage,
} from '@aws-sdk/client-amplify';
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  GetRoleCommand,
  type Role,
} from '@aws-sdk/client-iam';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const BRANDED_DOMAIN     = process.env.DWOMOH_BRANDED_DOMAIN     || 'dwomohvibe.app';
const AWS_ACCESS_KEY_ID  = process.env.AWS_ACCESS_KEY_ID          || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY  || '';
const AWS_REGION         = process.env.AWS_REGION                 || 'us-east-1';

const AMPLIFY_ROLE_NAME  = 'DwomohAmplifyServiceRole';
const AMPLIFY_ROLE_POLICY = 'arn:aws:iam::aws:policy/AdministratorAccess-Amplify';
const ENV_LOCAL_PATH     = join(process.cwd(), '.env.local');

// ACM for Amplify/CloudFront MUST be in us-east-1 regardless of app region
const ACM_REGION = 'us-east-1';

// ─── Client Factories ─────────────────────────────────────────────────────────

function credentials() {
  return { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY };
}

function r53()     { return new Route53Client({ region: 'us-east-1', credentials: credentials() }); }
function acm()     { return new ACMClient({ region: ACM_REGION, credentials: credentials() }); }
function amplify() { return new AmplifyClient({ region: AWS_REGION, credentials: credentials() }); }
function iam()     { return new IAMClient({ region: 'us-east-1', credentials: credentials() }); }

// ─── Setup Status ─────────────────────────────────────────────────────────────

export interface AwsSetupStatus {
  domain: string;
  hostedZone: {
    id: string;
    name: string;
    nameservers?: string[];
    recordCount?: number;
  } | null;
  certificate: {
    arn: string;
    status: string;
    isWildcard: boolean;
    domains?: string[];
    issuedAt?: string;
    expiresAt?: string;
  } | null;
  iamRole: { arn: string; name: string } | null;
  amplifyDomain: {
    verified: boolean;
    status: string;
    sentinelAppId: string;
    cfDistribution?: string;
    certVerificationRecord?: string;
  } | null;
  amplifyDomainVerified: boolean;
  dnsRecords?: Array<{ type: string; name: string; value: string }>;
  ready: boolean;
  steps: SetupStep[];
  checkedAt: string;
}

export interface SetupStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  detail?: string;
}

export interface SetupProgress {
  step: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  detail?: string;
}

// ─── Env Updater ──────────────────────────────────────────────────────────────

async function updateEnvLocal(vars: Record<string, string>): Promise<void> {
  let content = '';
  try { content = await readFile(ENV_LOCAL_PATH, 'utf-8'); } catch { /* new file */ }

  for (const [key, value] of Object.entries(vars)) {
    const commentedLine = new RegExp(`^#\\s*${key}=.*$`, 'm');
    const activeLine    = new RegExp(`^${key}=.*$`, 'm');

    if (activeLine.test(content)) {
      content = content.replace(activeLine, `${key}=${value}`);
    } else if (commentedLine.test(content)) {
      // Uncomment the existing commented line
      content = content.replace(commentedLine, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  await writeFile(ENV_LOCAL_PATH, content, 'utf-8');
}

// ─── Step 1: Route 53 Hosted Zone ─────────────────────────────────────────────

export async function findHostedZone(): Promise<{ id: string; name: string } | null> {
  const client = r53();
  try {
    const res = await client.send(new ListHostedZonesByNameCommand({
      DNSName: BRANDED_DOMAIN,
      MaxItems: 5,
    }));

    const zone = res.HostedZones?.find(z =>
      z.Name === `${BRANDED_DOMAIN}.` || z.Name === BRANDED_DOMAIN
    );

    if (!zone) return null;

    const id = zone.Id!.replace('/hostedzone/', '');
    return { id, name: zone.Name! };
  } catch {
    return null;
  }
}

// ─── Step 2: ACM Wildcard Certificate ─────────────────────────────────────────

async function findExistingCertificate(): Promise<{ arn: string; status: string } | null> {
  const client = acm();
  try {
    const list = await client.send(new ListCertificatesCommand({
      CertificateStatuses: [
        CertificateStatus.ISSUED,
        CertificateStatus.PENDING_VALIDATION,
      ],
      MaxItems: 100,
    }));

    for (const cert of list.CertificateSummaryList ?? []) {
      if (!cert.CertificateArn) continue;
      // Check if it covers *.dwomohvibe.app
      if (cert.DomainName === `*.${BRANDED_DOMAIN}` ||
          cert.SubjectAlternativeNameSummaries?.includes(`*.${BRANDED_DOMAIN}`)) {
        const detail = await client.send(new DescribeCertificateCommand({
          CertificateArn: cert.CertificateArn,
        }));
        return {
          arn: cert.CertificateArn,
          status: detail.Certificate?.Status ?? 'UNKNOWN',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function requestWildcardCertificate(): Promise<string> {
  const client = acm();
  const res = await client.send(new RequestCertificateCommand({
    DomainName: `*.${BRANDED_DOMAIN}`,
    SubjectAlternativeNames: [BRANDED_DOMAIN, `*.${BRANDED_DOMAIN}`],
    ValidationMethod: ValidationMethod.DNS,
    IdempotencyToken: 'dwomoh-vibe-code-wildcard',
    Tags: [
      { Key: 'Project', Value: 'DWOMOH-Vibe-Code' },
      { Key: 'Purpose', Value: 'BrandedHosting' },
    ],
  }));

  return res.CertificateArn!;
}

async function getCertificateValidationRecords(arn: string): Promise<DomainValidation[]> {
  const client = acm();
  // ACM takes a few seconds to generate the validation records
  for (let i = 0; i < 10; i++) {
    const res = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const records = res.Certificate?.DomainValidationOptions ?? [];
    const allHaveRecords = records.every(r => r.ResourceRecord?.Name && r.ResourceRecord?.Value);
    if (allHaveRecords && records.length > 0) return records;
    await new Promise(r => setTimeout(r, 3000));
  }
  return [];
}

async function addCertificateValidationRecordToRoute53(
  hostedZoneId: string,
  validationRecords: DomainValidation[]
): Promise<string | null> {
  const client = r53();

  // Deduplicate — wildcard + base domain share the same CNAME
  const seen = new Set<string>();
  const changes = validationRecords
    .filter(r => r.ResourceRecord?.Name && r.ResourceRecord?.Value)
    .filter(r => {
      const key = r.ResourceRecord!.Name!;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(r => ({
      Action: 'UPSERT' as const,
      ResourceRecordSet: {
        Name: r.ResourceRecord!.Name!,
        Type: 'CNAME' as const,
        TTL: 300,
        ResourceRecords: [{ Value: r.ResourceRecord!.Value! }],
      },
    }));

  if (changes.length === 0) return null;

  const res = await client.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: 'DWOMOH Vibe Code — ACM wildcard certificate DNS validation',
      Changes: changes,
    },
  }));

  return res.ChangeInfo?.Id ?? null;
}

export async function waitForCertificate(arn: string, onProgress?: (msg: string) => void): Promise<boolean> {
  const client = acm();
  const start = Date.now();
  const timeout = 15 * 60 * 1000; // 15 minutes

  while (Date.now() - start < timeout) {
    const res = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const status = res.Certificate?.Status;

    if (status === CertificateStatus.ISSUED) return true;
    if (status === CertificateStatus.FAILED) return false;

    const elapsed = Math.round((Date.now() - start) / 1000);
    onProgress?.(`Certificate pending DNS validation… (${elapsed}s elapsed — usually takes 2–5 minutes)`);
    await new Promise(r => setTimeout(r, 10000));
  }
  return false;
}

// ─── Step 3: Amplify IAM Service Role ─────────────────────────────────────────

async function ensureAmplifyServiceRole(): Promise<{ arn: string; name: string }> {
  const client = iam();

  // Try to get existing role first
  try {
    const existing = await client.send(new GetRoleCommand({ RoleName: AMPLIFY_ROLE_NAME }));
    return { arn: existing.Role!.Arn!, name: AMPLIFY_ROLE_NAME };
  } catch { /* role doesn't exist yet — create it */ }

  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'amplify.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  const createRes = await client.send(new CreateRoleCommand({
    RoleName: AMPLIFY_ROLE_NAME,
    AssumeRolePolicyDocument: trustPolicy,
    Description: 'Amplify service role for DWOMOH Vibe Code — allows Amplify to access Route53, ACM, and build resources',
    Tags: [{ Key: 'Project', Value: 'DWOMOH-Vibe-Code' }],
  }));

  const role = createRes.Role!;

  await client.send(new AttachRolePolicyCommand({
    RoleName: AMPLIFY_ROLE_NAME,
    PolicyArn: AMPLIFY_ROLE_POLICY,
  }));

  return { arn: role.Arn!, name: role.RoleName! };
}

// ─── Step 4: Amplify Domain Verification ──────────────────────────────────────

/**
 * Creates a sentinel Amplify app that "owns" the dwomohvibe.app domain.
 * This is the one-time Amplify domain verification step.
 * All actual project apps will add subdomains via CreateDomainAssociation independently.
 */
async function ensureAmplifyDomainVerification(
  roleArn: string
): Promise<{ verified: boolean; appId?: string }> {
  const client = amplify();

  // Find existing sentinel app
  const list = await client.send(new ListAppsCommand({ maxResults: 100 }));
  let sentinelAppId = list.apps?.find(a => a.tags?.['dwomoh:role'] === 'domain-sentinel')?.appId;

  if (!sentinelAppId) {
    // Create sentinel app
    const createRes = await client.send(new CreateAppCommand({
      name: 'dwomoh-domain-sentinel',
      description: 'DWOMOH Vibe Code domain verification sentinel — do not delete',
      platform: Platform.WEB,
      iamServiceRoleArn: roleArn,
      tags: {
        'dwomoh:role':    'domain-sentinel',
        'dwomoh:domain':  BRANDED_DOMAIN,
        'dwomoh:managed': 'true',
      },
    }));
    sentinelAppId = createRes.app!.appId!;

    // Create a placeholder branch
    try {
      await client.send(new CreateBranchCommand({
        appId: sentinelAppId,
        branchName: 'main',
        stage: Stage.PRODUCTION,
        enableAutoBuild: false,
      }));
    } catch { /* branch might already exist */ }
  }

  // Try to create/verify domain association
  try {
    await client.send(new CreateDomainAssociationCommand({
      appId: sentinelAppId!,
      domainName: BRANDED_DOMAIN,
      subDomainSettings: [{ branchName: 'main', prefix: 'www' }],
      enableAutoSubDomain: false,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already associated is fine
    if (!msg.includes('already') && !msg.includes('DomainAssociation')) throw err;
  }

  // Check domain association status
  try {
    const assoc = await client.send(new GetDomainAssociationCommand({
      appId: sentinelAppId!,
      domainName: BRANDED_DOMAIN,
    }));
    const status = assoc.domainAssociation?.domainStatus ?? '';
    const verified = status === 'AVAILABLE' || status === 'PENDING_DEPLOYMENT';
    return { verified, appId: sentinelAppId };
  } catch {
    return { verified: false, appId: sentinelAppId };
  }
}

// ─── Main Setup Orchestrator ───────────────────────────────────────────────────

export type ProgressCallback = (progress: SetupProgress) => void;

export async function runAwsSetup(onProgress: ProgressCallback): Promise<AwsSetupStatus> {
  const steps: SetupStep[] = [
    { id: 'route53',     label: 'Route 53 Hosted Zone',           status: 'pending' },
    { id: 'certificate', label: 'ACM Wildcard SSL Certificate',    status: 'pending' },
    { id: 'dns-validate',label: 'DNS Certificate Validation',      status: 'pending' },
    { id: 'iam-role',    label: 'Amplify IAM Service Role',        status: 'pending' },
    { id: 'amplify',     label: 'Amplify Domain Verification',     status: 'pending' },
    { id: 'env',         label: 'Save Configuration',              status: 'pending' },
  ];

  const update = (id: string, status: SetupStep['status'], detail?: string) => {
    const step = steps.find(s => s.id === id);
    if (step) { step.status = status; step.detail = detail; }
    onProgress({ step: id, status, detail });
  };

  let hostedZone: { id: string; name: string } | null = null;
  let certificate: { arn: string; status: string; isWildcard: boolean } | null = null;
  let iamRole: { arn: string; name: string } | null = null;
  let amplifyDomainVerified = false;

  // ── Route 53 ──────────────────────────────────────────────────────────────
  update('route53', 'running', `Looking up hosted zone for ${BRANDED_DOMAIN}…`);
  hostedZone = await findHostedZone();

  if (!hostedZone) {
    update('route53', 'error',
      `Hosted zone for ${BRANDED_DOMAIN} not found in Route 53.\n` +
      `Purchase the domain through Route 53 (AWS Console → Route 53 → Register Domain) ` +
      `then run setup again. AWS automatically creates the hosted zone after purchase.`
    );
    return buildStatus(steps, hostedZone, certificate, iamRole, amplifyDomainVerified, null, []);
  }

  update('route53', 'done', `Hosted zone found: ${hostedZone.id}`);
  await updateEnvLocal({ DWOMOH_HOSTED_ZONE_ID: hostedZone.id });

  // ── ACM Certificate ────────────────────────────────────────────────────────
  update('certificate', 'running', 'Checking for existing wildcard certificate…');

  let certArn: string;
  let isNew = false;
  const existing = await findExistingCertificate();

  if (existing) {
    certArn = existing.arn;
    certificate = { arn: certArn, status: existing.status, isWildcard: true };
    if (existing.status === CertificateStatus.ISSUED) {
      update('certificate', 'done', `Existing certificate found and active: ${certArn}`);
      update('dns-validate', 'skipped', 'Certificate already issued');
    } else {
      update('certificate', 'done', `Existing certificate found (${existing.status}): ${certArn}`);
    }
  } else {
    update('certificate', 'running', `Requesting wildcard certificate for *.${BRANDED_DOMAIN}…`);
    certArn = await requestWildcardCertificate();
    certificate = { arn: certArn, status: 'PENDING_VALIDATION', isWildcard: true };
    isNew = true;
    update('certificate', 'done', `Certificate requested: ${certArn}`);
  }

  await updateEnvLocal({ ACM_CERTIFICATE_ARN: certArn });

  // ── DNS Validation ────────────────────────────────────────────────────────
  if (certificate.status !== CertificateStatus.ISSUED) {
    update('dns-validate', 'running', 'Fetching DNS validation records from ACM…');
    const validationRecords = await getCertificateValidationRecords(certArn);

    if (validationRecords.length > 0) {
      update('dns-validate', 'running', 'Adding validation CNAME records to Route 53…');
      await addCertificateValidationRecordToRoute53(hostedZone.id, validationRecords);

      update('dns-validate', 'running', 'Waiting for ACM to validate the certificate via DNS (2–10 minutes)…');
      const issued = await waitForCertificate(certArn, (msg) => {
        update('dns-validate', 'running', msg);
      });

      if (issued) {
        certificate.status = CertificateStatus.ISSUED;
        update('dns-validate', 'done', 'Certificate issued and validated via DNS');
      } else {
        update('dns-validate', 'error',
          'Certificate validation timed out. DNS may still be propagating. Run setup again in a few minutes.'
        );
        // Don't abort — IAM and Amplify setup can still proceed
      }
    } else {
      update('dns-validate', 'error', 'Could not retrieve validation records from ACM');
    }
  }

  // ── IAM Role ───────────────────────────────────────────────────────────────
  update('iam-role', 'running', `Creating Amplify service role "${AMPLIFY_ROLE_NAME}"…`);
  try {
    iamRole = await ensureAmplifyServiceRole();
    update('iam-role', 'done', `Role ready: ${iamRole.arn}`);
    await updateEnvLocal({ AMPLIFY_SERVICE_ROLE_ARN: iamRole.arn });
  } catch (err) {
    update('iam-role', 'error', err instanceof Error ? err.message : String(err));
    // Continue — role might already exist from a previous run
  }

  // ── Amplify Domain ────────────────────────────────────────────────────────
  if (iamRole) {
    update('amplify', 'running', `Verifying ${BRANDED_DOMAIN} in Amplify Hosting…`);
    try {
      const result = await ensureAmplifyDomainVerification(iamRole.arn);
      amplifyDomainVerified = result.verified;
      if (result.appId) {
        await updateEnvLocal({ AMPLIFY_SENTINEL_APP_ID: result.appId });
      }
      update('amplify', amplifyDomainVerified ? 'done' : 'running',
        amplifyDomainVerified
          ? `${BRANDED_DOMAIN} verified in Amplify — branded subdomains active`
          : `${BRANDED_DOMAIN} verification in progress (Amplify is validating DNS)`
      );
    } catch (err) {
      update('amplify', 'error', err instanceof Error ? err.message : String(err));
    }
  } else {
    update('amplify', 'skipped', 'Skipped — IAM role setup failed');
  }

  // ── Save Config ────────────────────────────────────────────────────────────
  update('env', 'running', 'Persisting configuration to .env.local…');
  await updateEnvLocal({
    DWOMOH_BRANDED_DOMAIN: BRANDED_DOMAIN,
    DWOMOH_SETUP_COMPLETE:  'true',
    DWOMOH_SETUP_DATE:      new Date().toISOString(),
  });
  update('env', 'done', 'Configuration saved — deployment system is ready');

  return buildStatus(steps, hostedZone, certificate, iamRole, amplifyDomainVerified, null, []);
}

function buildStatus(
  steps: SetupStep[],
  hostedZone: AwsSetupStatus['hostedZone'],
  certificate: AwsSetupStatus['certificate'],
  iamRole: AwsSetupStatus['iamRole'],
  amplifyDomainVerified: boolean,
  amplifyDomain: AwsSetupStatus['amplifyDomain'] = null,
  dnsRecords: AwsSetupStatus['dnsRecords'] = [],
): AwsSetupStatus {
  const ready =
    !!hostedZone &&
    certificate?.status === CertificateStatus.ISSUED &&
    !!iamRole &&
    amplifyDomainVerified;

  return {
    domain: BRANDED_DOMAIN,
    hostedZone,
    certificate,
    iamRole,
    amplifyDomainVerified,
    amplifyDomain,
    dnsRecords,
    ready,
    steps,
    checkedAt: new Date().toISOString(),
  };
}

// ─── Status Check (non-destructive) ──────────────────────────────────────────

export async function checkAwsSetupStatus(): Promise<AwsSetupStatus> {
  const steps: SetupStep[] = [
    { id: 'route53',     label: 'Route 53 Hosted Zone',           status: 'pending' },
    { id: 'certificate', label: 'ACM Wildcard SSL Certificate',    status: 'pending' },
    { id: 'iam-role',    label: 'Amplify IAM Service Role',        status: 'pending' },
    { id: 'amplify',     label: 'Amplify Domain Verification',     status: 'pending' },
  ];

  // ── Route 53: hosted zone + nameservers + DNS records ────────────────────
  let hostedZone: AwsSetupStatus['hostedZone'] = null;
  let dnsRecords: AwsSetupStatus['dnsRecords'] = [];

  const r53Client = r53();
  try {
    const listRes = await r53Client.send(new ListHostedZonesByNameCommand({
      DNSName: BRANDED_DOMAIN, MaxItems: 5,
    }));
    const zone = listRes.HostedZones?.find(z =>
      z.Name === `${BRANDED_DOMAIN}.` || z.Name === BRANDED_DOMAIN
    );
    if (zone) {
      const hzId = zone.Id!.replace('/hostedzone/', '');
      // Fetch nameservers
      let nameservers: string[] = [];
      try {
        const hzRes = await r53Client.send(new GetHostedZoneCommand({ Id: hzId }));
        nameservers = hzRes.DelegationSet?.NameServers ?? [];
      } catch { /* ignore */ }

      // Fetch DNS records
      try {
        const recRes = await r53Client.send(new ListResourceRecordSetsCommand({
          HostedZoneId: hzId, MaxItems: 100,
        }));
        dnsRecords = (recRes.ResourceRecordSets ?? []).map(r => ({
          type: r.Type ?? '',
          name: (r.Name ?? '').replace(/\.$/, ''),
          value: r.ResourceRecords?.map(v => v.Value).join(', ') ??
                 r.AliasTarget?.DNSName ?? '',
        }));
      } catch { /* ignore */ }

      hostedZone = { id: hzId, name: zone.Name!, nameservers, recordCount: dnsRecords.length };
      steps[0].status = 'done';
      steps[0].detail = `Zone: ${hzId} · ${nameservers.length} nameservers · ${dnsRecords.length} records`;
    } else {
      steps[0].status = 'error';
      steps[0].detail = 'Not found — purchase domain in Route 53';
    }
  } catch {
    steps[0].status = 'error';
    steps[0].detail = 'Route 53 API error';
  }

  // ── ACM Certificate: full detail ─────────────────────────────────────────
  let certificate: AwsSetupStatus['certificate'] = null;
  try {
    const acmClient = acm();
    const certArn = process.env.ACM_CERTIFICATE_ARN;
    let certDetail = null;

    if (certArn && !certArn.startsWith('#')) {
      try {
        certDetail = await acmClient.send(new DescribeCertificateCommand({ CertificateArn: certArn }));
      } catch { /* try listing */ }
    }

    if (!certDetail) {
      const list = await acmClient.send(new ListCertificatesCommand({
        CertificateStatuses: [CertificateStatus.ISSUED, CertificateStatus.PENDING_VALIDATION],
        MaxItems: 100,
      }));
      const match = list.CertificateSummaryList?.find(c =>
        c.DomainName === `*.${BRANDED_DOMAIN}` || c.DomainName === BRANDED_DOMAIN
      );
      if (match?.CertificateArn) {
        certDetail = await acmClient.send(new DescribeCertificateCommand({ CertificateArn: match.CertificateArn }));
      }
    }

    if (certDetail?.Certificate) {
      const c = certDetail.Certificate;
      certificate = {
        arn:       c.CertificateArn!,
        status:    c.Status ?? 'UNKNOWN',
        isWildcard: true,
        domains:   c.SubjectAlternativeNames ?? [c.DomainName ?? BRANDED_DOMAIN],
        issuedAt:  c.IssuedAt?.toISOString(),
        expiresAt: c.NotAfter?.toISOString(),
      };
      steps[1].status = c.Status === CertificateStatus.ISSUED ? 'done' : 'running';
      steps[1].detail = `${c.Status} · ${c.CertificateArn!.slice(-12)}`;
    } else {
      steps[1].status = 'error';
      steps[1].detail = 'No wildcard certificate found';
    }
  } catch {
    steps[1].status = 'error';
    steps[1].detail = 'ACM API error';
  }

  // ── IAM Role ─────────────────────────────────────────────────────────────
  let iamRole: AwsSetupStatus['iamRole'] = null;
  try {
    const res = await iam().send(new GetRoleCommand({ RoleName: AMPLIFY_ROLE_NAME }));
    iamRole = { arn: res.Role!.Arn!, name: AMPLIFY_ROLE_NAME };
    steps[2].status = 'done';
    steps[2].detail = `${AMPLIFY_ROLE_NAME} · ${iamRole.arn.split(':').pop()}`;
  } catch {
    steps[2].status = 'error';
    steps[2].detail = 'Role not found';
  }

  // ── Amplify Domain Association ────────────────────────────────────────────
  let amplifyDomainVerified = false;
  let amplifyDomain: AwsSetupStatus['amplifyDomain'] = null;
  const sentinelAppId = process.env.AMPLIFY_SENTINEL_APP_ID;

  if (sentinelAppId) {
    try {
      const ampClient = amplify();
      const assocRes = await ampClient.send(new GetDomainAssociationCommand({
        appId: sentinelAppId,
        domainName: BRANDED_DOMAIN,
      }));
      const da = assocRes.domainAssociation;
      const status = da?.domainStatus ?? 'UNKNOWN';
      const cfDistribution = da?.subDomains?.[0]?.dnsRecord?.split(' ').pop()?.replace(/\.$/, '');
      amplifyDomainVerified = status === 'AVAILABLE' || status === 'PENDING_DEPLOYMENT';
      amplifyDomain = {
        verified: amplifyDomainVerified,
        status,
        sentinelAppId,
        cfDistribution,
        certVerificationRecord: da?.certificateVerificationDNSRecord,
      };
      steps[3].status = amplifyDomainVerified ? 'done'
        : status === 'FAILED' ? 'error' : 'running';
      steps[3].detail = `Domain status: ${status}${cfDistribution ? ` · CloudFront: ${cfDistribution.slice(0, 20)}…` : ''}`;
    } catch {
      steps[3].status = 'error';
      steps[3].detail = 'Domain association not found';
    }
  } else {
    steps[3].status = iamRole ? 'pending' : 'skipped';
    steps[3].detail = sentinelAppId ? 'Checking…' : 'Not configured';
  }

  return buildStatus(steps, hostedZone, certificate, iamRole, amplifyDomainVerified, amplifyDomain, dnsRecords);
}
