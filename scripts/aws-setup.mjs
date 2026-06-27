#!/usr/bin/env node
/**
 * DWOMOH Vibe Code — AWS Production Setup Script
 * Run: node scripts/aws-setup.mjs
 *
 * Reads credentials from .env.local and configures:
 *   1. Route 53 Hosted Zone discovery
 *   2. ACM wildcard certificate (*.dwomohvibe.com + dwomohvibe.com)
 *   3. DNS validation records in Route 53
 *   4. Amplify IAM service role
 *   5. Amplify domain verification (sentinel app)
 *   6. Persists all config back to .env.local
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env.local');

// ─── Load .env.local ─────────────────────────────────────────────────────────
function loadEnv() {
  const raw = readFileSync(ENV_PATH, 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function updateEnv(updates) {
  let content = readFileSync(ENV_PATH, 'utf-8');
  for (const [key, value] of Object.entries(updates)) {
    const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
    const active    = new RegExp(`^${key}=.*$`, 'm');
    if (active.test(content)) {
      content = content.replace(active, `${key}=${value}`);
    } else if (commented.test(content)) {
      content = content.replace(commented, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
}

const ENV = loadEnv();
const DOMAIN       = ENV.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const AWS_KEY      = ENV.AWS_ACCESS_KEY_ID;
const AWS_SECRET   = ENV.AWS_SECRET_ACCESS_KEY;
const AWS_REGION   = ENV.AWS_REGION || 'us-east-1';

if (!AWS_KEY || !AWS_SECRET) {
  console.error('❌ AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY missing from .env.local');
  process.exit(1);
}

const creds = { accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET };

// ─── Coloured output ─────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

const step  = (n, label) => console.log(`\n${c.bold(c.cyan(`── Step ${n}:`))} ${c.bold(label)}`);
const ok    = msg => console.log(`  ${c.green('✓')} ${msg}`);
const warn  = msg => console.log(`  ${c.yellow('⚠')} ${msg}`);
const err   = msg => console.log(`  ${c.red('✗')} ${msg}`);
const info  = msg => console.log(`  ${c.dim(msg)}`);
const wait  = msg => process.stdout.write(`  ⏳ ${msg}\r`);

// ─── AWS SDK Imports ─────────────────────────────────────────────────────────
const { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } =
  await import('@aws-sdk/client-route-53');
const { ACMClient, RequestCertificateCommand, DescribeCertificateCommand, ListCertificatesCommand } =
  await import('@aws-sdk/client-acm');
const { AmplifyClient, CreateAppCommand, CreateBranchCommand,
        CreateDomainAssociationCommand, GetDomainAssociationCommand, ListAppsCommand } =
  await import('@aws-sdk/client-amplify');
const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand } =
  await import('@aws-sdk/client-iam');

const r53     = new Route53Client({ region: 'us-east-1', credentials: creds });
const acmCli  = new ACMClient({ region: 'us-east-1', credentials: creds }); // ACM must be us-east-1
const ampCli  = new AmplifyClient({ region: AWS_REGION, credentials: creds });
const iamCli  = new IAMClient({ region: 'us-east-1', credentials: creds });

// ─── Step 1: Route 53 Hosted Zone ────────────────────────────────────────────
step(1, `Route 53 Hosted Zone for ${DOMAIN}`);

const hzRes = await r53.send(new ListHostedZonesByNameCommand({ DNSName: DOMAIN, MaxItems: 5 }));
const hz = hzRes.HostedZones?.find(z => z.Name === `${DOMAIN}.` || z.Name === DOMAIN);

if (!hz) {
  err(`Hosted zone for ${DOMAIN} not found in Route 53.`);
  warn(`Route 53 automatically creates a hosted zone when you register a domain.`);
  warn(`If registration just completed, wait 5 minutes and re-run this script.`);
  process.exit(1);
}

const HZ_ID = hz.Id.replace('/hostedzone/', '');
ok(`Hosted zone found: ${c.cyan(HZ_ID)}`);
info(`Domain: ${hz.Name}  |  Records: ${hz.Config?.PrivateZone ? 'Private' : 'Public'}`);
updateEnv({ DWOMOH_HOSTED_ZONE_ID: HZ_ID });
ok(`Saved DWOMOH_HOSTED_ZONE_ID to .env.local`);

// ─── Step 2: ACM Wildcard Certificate ────────────────────────────────────────
step(2, `ACM Wildcard SSL Certificate for *.${DOMAIN}`);

// Check for existing certificate
let CERT_ARN = ENV.ACM_CERTIFICATE_ARN?.replace(/^#.*/, '').trim() || '';
let certStatus = '';

if (CERT_ARN) {
  info(`Checking existing certificate: ${CERT_ARN.slice(-24)}`);
  try {
    const certRes = await acmCli.send(new DescribeCertificateCommand({ CertificateArn: CERT_ARN }));
    certStatus = certRes.Certificate?.Status ?? 'UNKNOWN';
    ok(`Existing certificate status: ${c.cyan(certStatus)}`);
  } catch {
    CERT_ARN = '';
  }
}

if (!CERT_ARN) {
  // Check if one already exists in ACM
  const listRes = await acmCli.send(new ListCertificatesCommand({
    CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED'],
    MaxItems: 100,
  }));

  const existing = listRes.CertificateSummaryList?.find(c =>
    c.DomainName === `*.${DOMAIN}` || c.DomainName === DOMAIN
  );

  if (existing) {
    CERT_ARN = existing.CertificateArn;
    const detail = await acmCli.send(new DescribeCertificateCommand({ CertificateArn: CERT_ARN }));
    certStatus = detail.Certificate?.Status ?? 'PENDING_VALIDATION';
    ok(`Found existing certificate: ${CERT_ARN.slice(-24)} (${certStatus})`);
  } else {
    info(`Requesting new wildcard certificate for *.${DOMAIN} and ${DOMAIN}…`);
    const reqRes = await acmCli.send(new RequestCertificateCommand({
      DomainName: `*.${DOMAIN}`,
      SubjectAlternativeNames: [DOMAIN, `*.${DOMAIN}`],
      ValidationMethod: 'DNS',
      IdempotencyToken: 'dwomohvibecode2026',
      Tags: [
        { Key: 'Project', Value: 'DWOMOH-Vibe-Code' },
        { Key: 'Domain', Value: DOMAIN },
      ],
    }));
    CERT_ARN = reqRes.CertificateArn;
    certStatus = 'PENDING_VALIDATION';
    ok(`Certificate requested: ${CERT_ARN}`);
  }
  updateEnv({ ACM_CERTIFICATE_ARN: CERT_ARN });
  ok(`Saved ACM_CERTIFICATE_ARN to .env.local`);
}

// ─── Step 3: DNS Validation ───────────────────────────────────────────────────
if (certStatus !== 'ISSUED') {
  step(3, `DNS Validation for ACM Certificate`);

  // Wait for ACM to generate validation records (takes a few seconds)
  info(`Waiting for ACM to generate DNS validation records…`);
  let validationRecords = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const certDetail = await acmCli.send(new DescribeCertificateCommand({ CertificateArn: CERT_ARN }));
    const domainValidations = certDetail.Certificate?.DomainValidationOptions ?? [];
    validationRecords = domainValidations.filter(v => v.ResourceRecord?.Name && v.ResourceRecord?.Value);
    if (validationRecords.length > 0) break;
    await new Promise(r => setTimeout(r, 3000));
    process.stdout.write(`  ⏳ Attempt ${attempt + 1}/12 — waiting for validation records…\r`);
  }
  console.log('');

  if (validationRecords.length === 0) {
    warn('ACM has not generated validation records yet. Run this script again in 2 minutes.');
  } else {
    // Deduplicate records (wildcard + base share the same CNAME)
    const seen = new Set();
    const changes = [];
    for (const rec of validationRecords) {
      const key = rec.ResourceRecord.Name;
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: rec.ResourceRecord.Name,
          Type: 'CNAME',
          TTL: 300,
          ResourceRecords: [{ Value: rec.ResourceRecord.Value }],
        },
      });
      info(`CNAME: ${rec.ResourceRecord.Name}`);
      info(`    → ${rec.ResourceRecord.Value}`);
    }

    const changeRes = await r53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: HZ_ID,
      ChangeBatch: {
        Comment: 'DWOMOH Vibe Code — ACM DNS validation',
        Changes: changes,
      },
    }));
    ok(`DNS validation records added to Route 53 (Change ID: ${changeRes.ChangeInfo?.Id?.split('/').pop()})`);

    // Poll for certificate issuance
    info(`Polling ACM for certificate issuance (usually 2–5 minutes)…`);
    const start = Date.now();
    while (Date.now() - start < 12 * 60 * 1000) {
      const statusRes = await acmCli.send(new DescribeCertificateCommand({ CertificateArn: CERT_ARN }));
      certStatus = statusRes.Certificate?.Status ?? 'PENDING_VALIDATION';
      const elapsed = Math.round((Date.now() - start) / 1000);
      wait(`Certificate status: ${certStatus} (${elapsed}s elapsed)…`);
      if (certStatus === 'ISSUED') {
        console.log('');
        ok(`Certificate ISSUED: ${c.green(CERT_ARN)}`);
        break;
      }
      if (certStatus === 'FAILED') {
        console.log('');
        err(`Certificate validation FAILED. Check ACM Console for details.`);
        break;
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    if (certStatus !== 'ISSUED' && certStatus !== 'FAILED') {
      console.log('');
      warn(`Certificate still pending after 12 minutes. DNS propagation may be slow.`);
      warn(`The certificate will issue automatically once DNS propagates.`);
      warn(`Re-run this script to check status.`);
    }
  }
} else {
  step(3, `DNS Validation`);
  ok(`Certificate already ISSUED — skipping DNS validation`);
}

// ─── Step 4: IAM Service Role for Amplify ────────────────────────────────────
step(4, `Amplify IAM Service Role`);

const ROLE_NAME = 'DwomohAmplifyServiceRole';
let ROLE_ARN = '';

try {
  const roleRes = await iamCli.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  ROLE_ARN = roleRes.Role.Arn;
  ok(`Role already exists: ${ROLE_ARN}`);
} catch {
  info(`Creating IAM role: ${ROLE_NAME}`);
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'amplify.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  const createRes = await iamCli.send(new CreateRoleCommand({
    RoleName: ROLE_NAME,
    AssumeRolePolicyDocument: trustPolicy,
    Description: 'Amplify service role for DWOMOH Vibe Code',
    Tags: [{ Key: 'Project', Value: 'DWOMOH-Vibe-Code' }],
  }));
  ROLE_ARN = createRes.Role.Arn;

  await iamCli.send(new AttachRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess-Amplify',
  }));
  ok(`Role created and policy attached: ${ROLE_ARN}`);
}

updateEnv({ AMPLIFY_SERVICE_ROLE_ARN: ROLE_ARN });
ok(`Saved AMPLIFY_SERVICE_ROLE_ARN to .env.local`);

// ─── Step 5: Amplify Sentinel App + Domain Verification ──────────────────────
step(5, `Amplify Domain Verification for ${DOMAIN}`);

// Find existing sentinel app
const appsRes = await ampCli.send(new ListAppsCommand({ maxResults: 100 }));
let sentinelApp = appsRes.apps?.find(a => a.tags?.['dwomoh:role'] === 'domain-sentinel');
let SENTINEL_APP_ID = '';

if (sentinelApp) {
  SENTINEL_APP_ID = sentinelApp.appId;
  ok(`Sentinel app already exists: ${SENTINEL_APP_ID}`);
} else {
  info(`Creating sentinel Amplify app for domain verification…`);
  const createRes = await ampCli.send(new CreateAppCommand({
    name: 'dwomoh-domain-sentinel',
    description: 'DWOMOH Vibe Code domain verification — do not delete',
    platform: 'WEB',
    iamServiceRoleArn: ROLE_ARN,
    tags: {
      'dwomoh:role':    'domain-sentinel',
      'dwomoh:domain':  DOMAIN,
      'dwomoh:managed': 'true',
    },
  }));
  sentinelApp = createRes.app;
  SENTINEL_APP_ID = sentinelApp.appId;
  ok(`Sentinel app created: ${SENTINEL_APP_ID}`);
}

// Ensure main branch exists
try {
  await ampCli.send(new CreateBranchCommand({
    appId: SENTINEL_APP_ID,
    branchName: 'main',
    stage: 'PRODUCTION',
    enableAutoBuild: false,
  }));
  info(`Branch 'main' created on sentinel app`);
} catch (e) {
  if (!e.message?.includes('already')) info(`Branch 'main' already exists`);
}

updateEnv({ AMPLIFY_SENTINEL_APP_ID: SENTINEL_APP_ID });
ok(`Saved AMPLIFY_SENTINEL_APP_ID to .env.local`);

// Create domain association
info(`Associating ${DOMAIN} with Amplify sentinel app…`);
try {
  await ampCli.send(new CreateDomainAssociationCommand({
    appId: SENTINEL_APP_ID,
    domainName: DOMAIN,
    subDomainSettings: [{ branchName: 'main', prefix: 'www' }],
    enableAutoSubDomain: false,
  }));
  ok(`Domain association created`);
} catch (e) {
  if (e.message?.includes('already') || e.name === 'DomainAssociationAlreadyExistsException') {
    ok(`Domain association already exists`);
  } else {
    warn(`Domain association: ${e.message}`);
  }
}

// Check domain status
info(`Checking domain association status…`);
try {
  const assocRes = await ampCli.send(new GetDomainAssociationCommand({
    appId: SENTINEL_APP_ID,
    domainName: DOMAIN,
  }));
  const domainStatus = assocRes.domainAssociation?.domainStatus ?? 'PENDING';
  if (domainStatus === 'AVAILABLE') {
    ok(`Domain ${DOMAIN} is AVAILABLE in Amplify`);
  } else {
    info(`Domain status: ${domainStatus} (may take a few minutes to propagate)`);
    // Print DNS records Amplify needs (in case they need to be added manually)
    const certRecord = assocRes.domainAssociation?.certificateVerificationDNSRecord;
    if (certRecord) {
      info(`Amplify verification record (add to Route 53 if not already there):`);
      info(`  ${certRecord}`);
    }
  }
} catch (e) {
  warn(`Could not check domain status: ${e.message}`);
}

// ─── Step 6: Summary ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(c.bold(c.green(`\n✓ AWS Production Setup Complete\n`)));
console.log(`  ${c.bold('Domain:')}         ${DOMAIN}`);
console.log(`  ${c.bold('Hosted Zone ID:')} ${HZ_ID}`);
console.log(`  ${c.bold('ACM Cert ARN:')}   ${CERT_ARN}`);
console.log(`  ${c.bold('ACM Status:')}     ${certStatus}`);
console.log(`  ${c.bold('IAM Role:')}       ${ROLE_ARN}`);
console.log(`  ${c.bold('Sentinel App:')}   ${SENTINEL_APP_ID}`);
console.log(`\n  All config saved to .env.local`);
console.log(`  Subdomains will be: {slug}.${DOMAIN}`);
if (certStatus !== 'ISSUED') {
  console.log(c.yellow(`\n  ⚠  ACM certificate is ${certStatus}`));
  console.log(c.yellow(`     DNS validation may take 2–10 more minutes.`));
  console.log(c.yellow(`     Re-run this script to check: node scripts/aws-setup.mjs`));
}
console.log(`\n  Next: Open the builder → Deploy any project → it goes live at {slug}.${DOMAIN}\n`);
