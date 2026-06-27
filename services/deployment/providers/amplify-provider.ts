/**
 * AWS Amplify Deployment Provider — CodeCommit Edition
 *
 * Deployment flow (SSR-capable via Lambda@Edge):
 *   1. Ensure IAM role has CodeCommit read access
 *   2. Create or find a CodeCommit repo for the project
 *   3. Push source files to CodeCommit via batch CreateCommit API
 *      – Includes amplify.yml (npm install --include=dev + next build)
 *      – Includes patched next.config.js (webpack alias + ignoreBuildErrors)
 *   4. Create/reuse Amplify WEB_COMPUTE app connected to CodeCommit
 *   5. Create branch + StartJob → Amplify builds with full Lambda@Edge SSR
 *   6. Attach {slug}.dwomohvibe.com via Domain Association
 *   7. Auto-wire Route 53 CNAME when AWAITING_APP_CNAME
 *
 * Key lessons from debugging:
 *   - Manual zip deploys serve from S3 only (no Lambda@Edge), always return 404 for SSR
 *   - Amplify prod env sets NODE_ENV=production → npm skips devDependencies
 *   - Use `npm install --include=dev` in preBuild to include tailwindcss/postcss
 *   - Next.js tsconfig path aliases (@/*) may not resolve without explicit webpack alias
 *   - better-sqlite3 must be in serverExternalPackages to avoid bundling native module
 */

import {
  AmplifyClient,
  CreateAppCommand,
  CreateBranchCommand,
  StartJobCommand,
  GetJobCommand,
  CreateDomainAssociationCommand,
  DeleteDomainAssociationCommand,
  GetDomainAssociationCommand,
  DeleteAppCommand,
  ListAppsCommand,
  JobStatus,
  JobType,
  Platform,
  Stage,
  UpdateAppCommand,
  type App,
  type DomainAssociation,
} from '@aws-sdk/client-amplify';

import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  GetBranchCommand,
  CreateCommitCommand,
  ListRepositoriesCommand,
} from '@aws-sdk/client-codecommit';

import {
  IAMClient,
  AttachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
} from '@aws-sdk/client-iam';

import {
  Route53Client,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';

import { join } from 'path';

import type {
  DeploymentProvider,
  DeployConfig,
  DeployResult,
  DeployStatusResult,
  CustomDomainRecord,
  DnsRecord,
} from '../types';
import { slugifyProjectName, buildBrandedUrl, BRANDED_DOMAIN } from '../dns-manager';

const AWS_REGION = process.env.AWS_REGION  || 'us-east-1';
const AWS_KEY    = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY || '';
const ROLE_ARN   = process.env.AMPLIFY_SERVICE_ROLE_ARN || '';
const HZ_ID      = process.env.DWOMOH_HOSTED_ZONE_ID || '';

const creds = () => ({ accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET });
const amp   = () => new AmplifyClient({ region: AWS_REGION, credentials: creds() });
const cc    = () => new CodeCommitClient({ region: AWS_REGION, credentials: creds() });
const iam   = () => new IAMClient({ region: 'us-east-1', credentials: creds() });
const r53   = () => new Route53Client({ region: 'us-east-1', credentials: creds() });

/** amplify.yml baked into every project so Amplify uses npm install --include=dev */
const AMPLIFY_YML = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm install --include=dev
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;

/** next.config.js override injected into every deployment */
const NEXT_CONFIG_JS = `const path = require('path');
/** @type {import('next').NextConfig} */
module.exports = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config) => {
    // Explicit alias ensures @/* resolves even when tsconfig paths aren't picked up
    config.resolve.alias['@'] = path.resolve(process.cwd());
    return config;
  },
};
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findExistingApp(projectId: string): Promise<App | null> {
  try {
    const res = await amp().send(new ListAppsCommand({ maxResults: 100 }));
    return res.apps?.find(a => a.tags?.['dwomoh:projectId'] === projectId) ?? null;
  } catch { return null; }
}

async function ensureCodeCommitAccess(): Promise<void> {
  if (!ROLE_ARN) return;
  const roleName = ROLE_ARN.split('/').pop()!;
  try {
    const res = await iam().send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
    const hasCC = res.AttachedPolicies?.some(p => p.PolicyName?.includes('CodeCommit'));
    if (!hasCC) {
      await iam().send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AWSCodeCommitReadOnly',
      }));
    }
  } catch { /* non-fatal if IAM perms aren't available */ }
}

/**
 * Collect source files from project directory.
 * Excludes node_modules, .next, .git, and large files.
 */
async function collectSourceFiles(projectPath: string): Promise<Array<{ filePath: string; fileContent: Buffer }>> {
  const { readdirSync, statSync, readFileSync, existsSync } = await import('fs');
  const MAX_FILE  = 5 * 1024 * 1024;
  const IGNORE_DIRS = new Set([
    'node_modules', '.next', '.git', 'generated-projects',
    'project.db-shm', 'project.db-wal',
  ]);
  const IGNORE_FILES = new Set(['.dwomoh-deploy.zip', 'tsconfig.tsbuildinfo']);

  const files: Array<{ filePath: string; fileContent: Buffer }> = [];

  function collect(dir: string, prefix: string) {
    for (const entry of readdirSync(dir)) {
      if (IGNORE_DIRS.has(entry) || IGNORE_FILES.has(entry)) continue;
      const full = join(dir, entry);
      const rel  = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collect(full, rel);
      } else if (stat.size < MAX_FILE) {
        try { files.push({ filePath: rel, fileContent: readFileSync(full) }); } catch { /* skip */ }
      }
    }
  }

  collect(projectPath, '');

  // Override next.config.js and amplify.yml with deployment-safe versions
  const nextConfigIdx = files.findIndex(f => f.filePath === 'next.config.js');
  if (nextConfigIdx >= 0) files[nextConfigIdx].fileContent = Buffer.from(NEXT_CONFIG_JS);
  else files.push({ filePath: 'next.config.js', fileContent: Buffer.from(NEXT_CONFIG_JS) });

  const amplifyYmlIdx = files.findIndex(f => f.filePath === 'amplify.yml');
  if (amplifyYmlIdx >= 0) files[amplifyYmlIdx].fileContent = Buffer.from(AMPLIFY_YML);
  else files.push({ filePath: 'amplify.yml', fileContent: Buffer.from(AMPLIFY_YML) });

  return files;
}

/**
 * Push source files to CodeCommit in batches.
 * Returns the final commit ID.
 */
async function pushToCodeCommit(
  repoName: string,
  files: Array<{ filePath: string; fileContent: Buffer }>,
): Promise<string> {
  const client = cc();
  const BATCH_BYTES = 15 * 1024 * 1024; // 15MB per commit

  // Get current HEAD (if repo has commits)
  let parentCommitId: string | undefined;
  try {
    const branch = await client.send(new GetBranchCommand({ repositoryName: repoName, branchName: 'main' }));
    parentCommitId = branch.branch?.commitId;
  } catch { /* first commit — no parent */ }

  // Split into batches
  const batches: typeof files[] = [];
  let batch: typeof files = [];
  let batchSize = 0;

  for (const f of files) {
    const sz = f.fileContent.length;
    if (batchSize + sz > BATCH_BYTES && batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchSize = 0;
    }
    batch.push(f);
    batchSize += sz;
  }
  if (batch.length > 0) batches.push(batch);

  let commitId = parentCommitId ?? '';
  for (let i = 0; i < batches.length; i++) {
    const res = await client.send(new CreateCommitCommand({
      repositoryName: repoName,
      branchName: 'main',
      ...(commitId ? { parentCommitId: commitId } : {}),
      authorName: 'DWOMOH Vibe Code',
      email: 'build@dwomohvibe.app',
      commitMessage: `DWOMOH deploy — batch ${i + 1}/${batches.length}`,
      putFiles: batches[i],
    }));
    commitId = res.commitId ?? commitId;
  }

  return commitId;
}

/**
 * Ensure a CodeCommit repo exists for this project.
 * Creates it if missing. Returns the repo name.
 */
async function ensureCodeCommitRepo(slug: string, projectId: string, projectName: string): Promise<string> {
  const repoName = `dwomoh-${slug}`;
  const client = cc();
  try {
    await client.send(new GetRepositoryCommand({ repositoryName: repoName }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('RepositoryDoesNotExist') || msg.includes('Repository') ) {
      await client.send(new CreateRepositoryCommand({
        repositoryName: repoName,
        repositoryDescription: `DWOMOH Vibe Code — ${projectName}`,
        tags: { 'dwomoh:projectId': projectId, 'dwomoh:slug': slug },
      }));
    } else throw e;
  }
  return repoName;
}

/**
 * Auto-wire Route 53 CNAME when Amplify is waiting for it.
 */
async function ensureCnameInRoute53(slug: string, cfDistribution: string): Promise<void> {
  if (!HZ_ID || !cfDistribution) return;
  try {
    const existing = await r53().send(new ListResourceRecordSetsCommand({ HostedZoneId: HZ_ID }));
    const has = existing.ResourceRecordSets?.some(
      r => r.Type === 'CNAME' && r.Name?.startsWith(slug) && r.ResourceRecords?.[0]?.Value === cfDistribution
    );
    if (!has) {
      await r53().send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: HZ_ID,
        ChangeBatch: {
          Comment: `DWOMOH Vibe Code: ${slug}`,
          Changes: [{
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: `${slug}.${BRANDED_DOMAIN}`,
              Type: 'CNAME',
              TTL: 300,
              ResourceRecords: [{ Value: cfDistribution }],
            },
          }],
        },
      }));
    }
  } catch (e) {
    console.warn('[amplify] Route 53 CNAME auto-wire failed:', e instanceof Error ? e.message : e);
  }
}

// ─── AmplifyProvider ─────────────────────────────────────────────────────────

export class AmplifyProvider implements DeploymentProvider {
  readonly name = 'amplify' as const;
  readonly displayName = 'AWS Amplify';

  async deploy(config: DeployConfig): Promise<DeployResult> {
    const client  = amp();
    const slug    = slugifyProjectName(config.projectName);
    const brandedUrl = buildBrandedUrl(slug);
    const repoName   = `dwomoh-${slug}`;
    const ccUrl      = `https://git-codecommit.${AWS_REGION}.amazonaws.com/v1/repos/${repoName}`;
    const now        = new Date().toISOString();

    // 1. Ensure IAM role can read CodeCommit
    await ensureCodeCommitAccess();

    // 2. Create/find CodeCommit repo
    await ensureCodeCommitRepo(slug, config.projectId, config.projectName);

    // 3. Collect + push source files
    const sourceFiles = await collectSourceFiles(config.projectPath);
    await pushToCodeCommit(repoName, sourceFiles);

    // 4. Find existing Amplify app or create new one connected to CodeCommit
    let appId: string;
    const existingApp = await findExistingApp(config.projectId);

    if (existingApp) {
      appId = existingApp.appId!;
      // Ensure it's connected to CodeCommit (not an old manual deploy app)
      if (!existingApp.repository?.includes('codecommit')) {
        await client.send(new UpdateAppCommand({
          appId,
          repository: ccUrl,
          platform: Platform.WEB_COMPUTE,
          buildSpec: AMPLIFY_YML,
        }));
      }
    } else {
      const createRes = await client.send(new CreateAppCommand({
        name:              `dwomoh-${slug}`,
        description:       `DWOMOH Vibe Code — ${config.projectName}`,
        repository:        ccUrl,
        platform:          Platform.WEB_COMPUTE,
        iamServiceRoleArn: ROLE_ARN || undefined,
        buildSpec:         AMPLIFY_YML,
        environmentVariables: {
          ...config.envVars,
          NODE_ENV:                'production',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        tags: {
          'dwomoh:projectId':   config.projectId,
          'dwomoh:projectName': config.projectName,
          'dwomoh:slug':        slug,
          'dwomoh:managed':     'true',
          'dwomoh:source':      'codecommit',
        },
      }));
      appId = createRes.app!.appId!;
    }

    // 5. Create/ensure branch with auto-build enabled
    try {
      await client.send(new CreateBranchCommand({
        appId,
        branchName:      'main',
        stage:           Stage.PRODUCTION,
        enableAutoBuild: true,
        framework:       'Next.js - SSR',
        environmentVariables: { NODE_ENV: 'production' },
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already')) throw err;
    }

    // 6. Start build job
    const jobRes = await client.send(new StartJobCommand({
      appId,
      branchName: 'main',
      jobType:    JobType.RELEASE,
      jobReason:  'DWOMOH Vibe Code deploy',
    }));

    const jobId      = jobRes.jobSummary!.jobId!;
    const providerUrl = `https://main.${appId}.amplifyapp.com`;

    // Attach domain asynchronously (non-blocking)
    this.attachBrandedSubdomain(client, appId, slug).catch(err =>
      console.warn('[amplify] domain setup (non-blocking):', err)
    );

    return {
      deploymentId:  jobId,
      providerAppId: appId,
      providerUrl,
      brandedUrl,
      status:    'building',
      provider:  'amplify',
      startedAt: now,
    };
  }

  /** Attach {slug}.dwomohvibe.com and auto-wire Route 53 CNAME */
  async attachBrandedSubdomain(client: AmplifyClient, appId: string, slug: string): Promise<void> {
    try {
      await client.send(new CreateDomainAssociationCommand({
        appId,
        domainName:         BRANDED_DOMAIN,
        subDomainSettings:  [{ branchName: 'main', prefix: slug }],
        enableAutoSubDomain: false,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already') && !msg.includes('DomainAssociation')) throw err;
    }
  }

  async getStatus(providerAppId: string, deploymentId: string): Promise<DeployStatusResult> {
    try {
      const res = await amp().send(new GetJobCommand({
        appId:      providerAppId,
        branchName: 'main',
        jobId:      deploymentId,
      }));
      const job    = res.job!;
      const status = mapJobStatus(job.summary?.status);
      const logs: string[] = [];
      for (const step of job.steps ?? []) {
        if (step.logUrl) logs.push(`[${step.stepName}] ${step.logUrl}`);
      }
      return {
        deploymentId,
        status,
        brandedUrl:   '',
        providerUrl:  `https://main.${providerAppId}.amplifyapp.com`,
        logs,
        completedAt:  job.summary?.endTime?.toISOString(),
        errorMessage: status === 'failed' ? (job.summary?.status ?? 'Build failed') : undefined,
      };
    } catch (err) {
      return { deploymentId, status: 'failed', brandedUrl: '', providerUrl: '', errorMessage: String(err) };
    }
  }

  async getLogs(providerAppId: string, deploymentId: string): Promise<string[]> {
    return (await this.getStatus(providerAppId, deploymentId)).logs ?? [];
  }

  async attachDomain(providerAppId: string, domain: string): Promise<CustomDomainRecord> {
    const now = new Date().toISOString();
    try {
      const res = await amp().send(new CreateDomainAssociationCommand({
        appId: providerAppId, domainName: domain,
        subDomainSettings: [{ branchName: 'main', prefix: '' }],
        enableAutoSubDomain: false,
      }));
      return { domain, status: 'pending_verification', dnsRecords: this.extractDnsRecords(res.domainAssociation!), addedAt: now };
    } catch {
      return { domain, status: 'failed', dnsRecords: [], addedAt: now };
    }
  }

  async detachDomain(providerAppId: string, domain: string): Promise<void> {
    try {
      await amp().send(new DeleteDomainAssociationCommand({ appId: providerAppId, domainName: domain }));
    } catch { /* ignore */ }
  }

  async getDomainStatus(providerAppId: string, domain: string): Promise<{ status: string; dnsRecords: DnsRecord[] }> {
    try {
      const res = await amp().send(new GetDomainAssociationCommand({ appId: providerAppId, domainName: domain }));
      const assoc = res.domainAssociation!;
      const s = assoc.domainStatus ?? '';
      const status = s === 'AVAILABLE' ? 'active' : s === 'FAILED' ? 'failed' : s === 'PENDING_VERIFICATION' ? 'pending_verification' : 'verifying';
      return { status, dnsRecords: this.extractDnsRecords(assoc) };
    } catch { return { status: 'failed', dnsRecords: [] }; }
  }

  async destroy(providerAppId: string): Promise<void> {
    try { await amp().send(new DeleteAppCommand({ appId: providerAppId })); } catch { /* ignore */ }
  }

  private extractDnsRecords(assoc: DomainAssociation): DnsRecord[] {
    const records: DnsRecord[] = [];
    if (assoc.certificateVerificationDNSRecord) {
      const parts = assoc.certificateVerificationDNSRecord.split(' CNAME ');
      if (parts.length === 2) records.push({ type: 'CNAME', name: parts[0].trim(), value: parts[1].trim() });
    }
    for (const sub of assoc.subDomains ?? []) {
      if (sub.dnsRecord) {
        const parts = sub.dnsRecord.split(' CNAME ');
        if (parts.length === 2) records.push({ type: 'CNAME', name: parts[0].trim(), value: parts[1].trim() });
      }
    }
    return records;
  }
}

function mapJobStatus(jobStatus: JobStatus | undefined) {
  switch (jobStatus) {
    case JobStatus.SUCCEED:     return 'live' as const;
    case JobStatus.FAILED:      return 'failed' as const;
    case JobStatus.RUNNING:     return 'building' as const;
    case JobStatus.PENDING:
    case JobStatus.PROVISIONING: return 'pending' as const;
    default:                    return 'pending' as const;
  }
}
