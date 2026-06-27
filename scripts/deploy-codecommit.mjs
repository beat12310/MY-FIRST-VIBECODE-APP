#!/usr/bin/env node
/**
 * DWOMOH Vibe Code — CodeCommit + Amplify SSR Deploy
 *
 * Deploys a generated project to Amplify via CodeCommit:
 *   1. Creates a CodeCommit repo (or finds existing)
 *   2. Pushes source files via the API (no git needed)
 *   3. Creates Amplify app connected to CodeCommit
 *   4. Amplify builds with full WEB_COMPUTE (Lambda@Edge) support
 *   5. Maps {slug}.dwomohvibe.com → live SSR app
 *
 * Usage:
 *   node scripts/deploy-codecommit.mjs [project-dir-name]
 *   node scripts/deploy-codecommit.mjs adepas-collection
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT         = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_NAME = process.argv[2] || 'adepas-collection';
const PROJECT_DIR  = join(ROOT, 'generated-projects', PROJECT_NAME);

if (!existsSync(PROJECT_DIR)) { console.error(`Project not found: ${PROJECT_DIR}`); process.exit(1); }

// ─── Load env ────────────────────────────────────────────────────────────────
const ENV = {};
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i === -1) continue;
  ENV[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const creds  = { accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY };
const DOMAIN = ENV.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const ROLE   = ENV.AMPLIFY_SERVICE_ROLE_ARN;
const REGION = ENV.AWS_REGION || 'us-east-1';
const HZ_ID  = ENV.DWOMOH_HOSTED_ZONE_ID;

const c = {
  g:  s => `\x1b[32m${s}\x1b[0m`,  y: s => `\x1b[33m${s}\x1b[0m`,
  r:  s => `\x1b[31m${s}\x1b[0m`,  cy: s => `\x1b[36m${s}\x1b[0m`,
  b:  s => `\x1b[1m${s}\x1b[0m`,   d: s => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, l) => console.log(`\n${c.b(c.cy(`── Step ${n}:`))} ${c.b(l)}`);
const ok   = m => console.log(`  ${c.g('✓')} ${m}`);
const info = m => console.log(`  ${c.d(m)}`);
const warn = m => console.log(`  ${c.y('⚠')} ${m}`);
const wait = m => process.stdout.write(`  ⏳ ${m}\r`);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

const SLUG        = slugify(PROJECT_NAME);
const BRANDED_URL = `https://${SLUG}.${DOMAIN}`;
const PROJECT_ID  = `proj-${SLUG}`;
const REPO_NAME   = `dwomoh-${SLUG}`;
const CC_URL      = `https://git-codecommit.${REGION}.amazonaws.com/v1/repos/${REPO_NAME}`;

// ─── AWS SDK imports ──────────────────────────────────────────────────────────
const {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  CreateCommitCommand,
  GetBranchCommand,
  ListRepositoriesCommand,
} = await import('@aws-sdk/client-codecommit');

const {
  AmplifyClient,
  CreateAppCommand,
  ListAppsCommand,
  DeleteAppCommand,
  CreateBranchCommand,
  StartJobCommand,
  GetJobCommand,
  CreateDomainAssociationCommand,
  GetDomainAssociationCommand,
  UpdateAppCommand,
  JobType,
  JobStatus,
} = await import('@aws-sdk/client-amplify');

const {
  IAMClient,
  AttachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
} = await import('@aws-sdk/client-iam');

const {
  Route53Client,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
} = await import('@aws-sdk/client-route-53');

const ccCli  = new CodeCommitClient({ region: REGION, credentials: creds });
const ampCli = new AmplifyClient({ region: REGION, credentials: creds });
const iamCli = new IAMClient({ region: 'us-east-1', credentials: creds });
const r53    = new Route53Client({ region: 'us-east-1', credentials: creds });

// ─── Ensure IAM role has CodeCommit access ───────────────────────────────────
step(1, `IAM: Ensure CodeCommit access on DwomohAmplifyServiceRole`);

const roleName = ROLE?.split('/').pop() ?? 'DwomohAmplifyServiceRole';
const existingPolicies = await iamCli.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
const hasCC = existingPolicies.AttachedPolicies?.some(p => p.PolicyName?.includes('CodeCommit'));
if (hasCC) {
  ok(`CodeCommit policy already attached`);
} else {
  await iamCli.send(new AttachRolePolicyCommand({
    RoleName: roleName,
    PolicyArn: 'arn:aws:iam::aws:policy/AWSCodeCommitReadOnly',
  }));
  ok(`Attached AWSCodeCommitReadOnly to ${roleName}`);
}

// ─── Create or find CodeCommit repo ──────────────────────────────────────────
step(2, `CodeCommit Repo: ${REPO_NAME}`);

let repoExists = false;
try {
  await ccCli.send(new GetRepositoryCommand({ repositoryName: REPO_NAME }));
  ok(`Repo already exists: ${REPO_NAME}`);
  repoExists = true;
} catch (e) {
  if (e.name === 'RepositoryDoesNotExistException') {
    await ccCli.send(new CreateRepositoryCommand({
      repositoryName: REPO_NAME,
      repositoryDescription: `DWOMOH Vibe Code — ${PROJECT_NAME}`,
      tags: { 'dwomoh:projectId': PROJECT_ID, 'dwomoh:slug': SLUG },
    }));
    ok(`Created repo: ${REPO_NAME}`);
  } else throw e;
}

// ─── Collect source files ─────────────────────────────────────────────────────
step(3, `Collect source files`);

const IGNORE_DIRS  = new Set(['node_modules', '.next', '.git', '.dwomoh-deploy.zip', 'project.db-shm', 'project.db-wal']);
const IGNORE_FILES = new Set(['.dwomoh-deploy.zip']);
const MAX_FILE     = 5 * 1024 * 1024; // 5MB

const sourceFiles = [];
let totalSize = 0;

function collect(dir, prefix) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry) || IGNORE_FILES.has(entry)) continue;
    const full = join(dir, entry);
    const rel  = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collect(full, rel);
    } else if (stat.size < MAX_FILE) {
      try {
        const content = readFileSync(full);
        sourceFiles.push({ filePath: rel, fileContent: content, fileMode: 'NORMAL' });
        totalSize += stat.size;
      } catch { /* skip locked */ }
    }
  }
}

collect(PROJECT_DIR, '');

// Add amplify.yml for proper SSR build config
const amplifyYml = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - .next/cache/**/*
      - node_modules/**/*
`;
sourceFiles.push({
  filePath: 'amplify.yml',
  fileContent: Buffer.from(amplifyYml),
  fileMode: 'NORMAL',
});

info(`Collected ${sourceFiles.length} files (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);

// ─── Push files to CodeCommit in batches ─────────────────────────────────────
step(4, `Push source to CodeCommit`);

// Split into batches of ~10MB each
const BATCH_MB = 10;
const batches = [];
let batch = [];
let batchSize = 0;

for (const f of sourceFiles) {
  const sz = f.fileContent.length;
  if (batchSize + sz > BATCH_MB * 1024 * 1024 && batch.length > 0) {
    batches.push(batch);
    batch = [];
    batchSize = 0;
  }
  batch.push(f);
  batchSize += sz;
}
if (batch.length > 0) batches.push(batch);

info(`Uploading ${batches.length} batch(es) to CodeCommit…`);

let parentCommitId = undefined;

// Check if repo already has commits
if (repoExists) {
  try {
    const branch = await ccCli.send(new GetBranchCommand({ repositoryName: REPO_NAME, branchName: 'main' }));
    parentCommitId = branch.branch?.commitId;
    info(`Existing branch main @ ${parentCommitId}`);
  } catch { /* no main branch yet */ }
}

for (let i = 0; i < batches.length; i++) {
  const b = batches[i];
  wait(`Batch ${i + 1}/${batches.length}: ${b.length} files…`);
  const res = await ccCli.send(new CreateCommitCommand({
    repositoryName: REPO_NAME,
    branchName: 'main',
    ...(parentCommitId ? { parentCommitId } : {}),
    authorName: 'DWOMOH Vibe Code',
    email: 'build@dwomohvibe.app',
    commitMessage: `Deploy ${PROJECT_NAME} — batch ${i + 1}/${batches.length}`,
    putFiles: b,
  }));
  parentCommitId = res.commitId;
  console.log(`\r  ${c.g('✓')} Batch ${i + 1}/${batches.length} committed (${res.commitId?.slice(0, 8)})`);
}

ok(`All source files pushed to CodeCommit`);
info(`Repo URL: ${CC_URL}`);

// ─── Create Amplify app connected to CodeCommit ───────────────────────────────
step(5, `Amplify App (WEB_COMPUTE + CodeCommit)`);

// Delete old manual-deploy app if it exists (had WEB_COMPUTE but served from S3)
let APP_ID = null;
const listRes = await ampCli.send(new ListAppsCommand({ maxResults: 100 }));
const existingApp = listRes.apps?.find(a => a.tags?.['dwomoh:projectId'] === PROJECT_ID);

if (existingApp) {
  info(`Removing old manual-deploy Amplify app ${existingApp.appId}…`);
  try {
    await ampCli.send(new DeleteAppCommand({ appId: existingApp.appId }));
    ok(`Deleted old app ${existingApp.appId}`);
  } catch (e) {
    warn(`Could not delete old app: ${e.message}`);
  }
}

info(`Creating Amplify app connected to CodeCommit…`);
const createRes = await ampCli.send(new CreateAppCommand({
  name: `dwomoh-${SLUG}`,
  description: `DWOMOH Vibe Code — ${PROJECT_NAME}`,
  repository: CC_URL,
  platform: 'WEB_COMPUTE',
  iamServiceRoleArn: ROLE,
  buildSpec: amplifyYml,
  environmentVariables: {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    _LIVE_UPDATES: JSON.stringify([{ pkg: 'node', type: 'nvm', version: '20' }]),
  },
  tags: {
    'dwomoh:projectId':   PROJECT_ID,
    'dwomoh:projectName': PROJECT_NAME,
    'dwomoh:slug':        SLUG,
    'dwomoh:managed':     'true',
    'dwomoh:source':      'codecommit',
  },
}));

APP_ID = createRes.app.appId;
ok(`Amplify app created: ${APP_ID}`);

// ─── Create branch + trigger build ───────────────────────────────────────────
step(6, `Create Branch + Trigger Build`);

try {
  await ampCli.send(new CreateBranchCommand({
    appId: APP_ID,
    branchName: 'main',
    stage: 'PRODUCTION',
    enableAutoBuild: true,
    framework: 'Next.js - SSR',
    environmentVariables: { NODE_ENV: 'production' },
  }));
  ok(`Branch 'main' created with auto-build enabled`);
} catch (e) {
  if (e.message?.includes('already')) { ok(`Branch already exists`); }
  else throw e;
}

info(`Starting build job…`);
const jobRes = await ampCli.send(new StartJobCommand({
  appId: APP_ID,
  branchName: 'main',
  jobType: JobType.RELEASE,
  jobReason: 'Initial deployment by DWOMOH Vibe Code',
}));
const jobId = jobRes.jobSummary?.jobId;
ok(`Build started: Job ${jobId}`);

// ─── Poll build ───────────────────────────────────────────────────────────────
step(7, `Build (typically 3–8 min for Next.js SSR)`);
info(`Building on Amplify's servers with full node_modules + npm run build…`);

const buildStart = Date.now();
let buildStatus  = '';

while (Date.now() - buildStart < 15 * 60 * 1000) {
  const job = await ampCli.send(new GetJobCommand({
    appId: APP_ID, branchName: 'main', jobId,
  }));
  buildStatus = job.job?.summary?.status ?? 'UNKNOWN';
  const elapsed = Math.round((Date.now() - buildStart) / 1000);
  wait(`Build: ${buildStatus} (${elapsed}s)…`);

  if (buildStatus === JobStatus.SUCCEED) {
    console.log('');
    ok(`Build succeeded in ${elapsed}s`);
    break;
  }
  if (buildStatus === JobStatus.FAILED || buildStatus === JobStatus.CANCELLED) {
    console.log('');
    console.error(`  ${c.r('✗')} Build ${buildStatus} after ${elapsed}s`);
    console.log(`  Amplify Console: https://${REGION}.console.aws.amazon.com/amplify/home#/${APP_ID}`);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 20_000));
}

if (buildStatus !== JobStatus.SUCCEED) {
  console.error(`  ${c.r('✗')} Build timed out`); process.exit(1);
}

// ─── Attach domain ────────────────────────────────────────────────────────────
step(8, `Attach Domain: ${SLUG}.${DOMAIN}`);

try {
  await ampCli.send(new CreateDomainAssociationCommand({
    appId: APP_ID,
    domainName: DOMAIN,
    subDomainSettings: [{ branchName: 'main', prefix: SLUG }],
    enableAutoSubDomain: false,
  }));
  ok(`Domain association created`);
} catch (e) {
  if (e.message?.includes('already') || e.name?.includes('AlreadyExists')) { ok(`Domain association already exists`); }
  else { warn(`Domain: ${e.message}`); }
}

// ─── Poll domain + auto-wire CNAME ───────────────────────────────────────────
step(9, `Wait for Domain + Auto-wire DNS`);

let domainStatus   = '';
let cfDistribution = null;
let cnameFixed     = false;
const domStart     = Date.now();

while (Date.now() - domStart < 10 * 60 * 1000) {
  try {
    const res = await ampCli.send(new GetDomainAssociationCommand({ appId: APP_ID, domainName: DOMAIN }));
    const da  = res.domainAssociation;
    domainStatus = da?.domainStatus ?? '';

    // Extract CloudFront distribution from subdomain DNS records
    const sub = da?.subDomains?.find(s => s.subDomainSetting?.prefix === SLUG);
    const dnsRecord = sub?.dnsRecord ?? '';
    const parts = dnsRecord.split(/\s+/);
    const cf = parts.find(p => p.includes('cloudfront.net'))?.replace(/\.$/, '');
    if (cf) cfDistribution = cf;

    const elapsed = Math.round((Date.now() - domStart) / 1000);
    wait(`Domain: ${domainStatus} (${elapsed}s) CF: ${cfDistribution ?? 'pending'}…`);

    // Auto-wire CNAME during AWAITING_APP_CNAME phase
    if ((domainStatus === 'AWAITING_APP_CNAME' || domainStatus === 'PENDING_DEPLOYMENT') && cfDistribution && HZ_ID && !cnameFixed) {
      console.log('');
      info(`Auto-wiring CNAME: ${SLUG}.${DOMAIN} → ${cfDistribution}`);
      try {
        const existing = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: HZ_ID }));
        const has = existing.ResourceRecordSets?.some(r => r.Type === 'CNAME' && r.Name?.startsWith(SLUG));
        if (!has) {
          await r53.send(new ChangeResourceRecordSetsCommand({
            HostedZoneId: HZ_ID,
            ChangeBatch: {
              Comment: `DWOMOH Vibe Code: ${SLUG}`,
              Changes: [{
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: `${SLUG}.${DOMAIN}`, Type: 'CNAME', TTL: 300,
                  ResourceRecords: [{ Value: cfDistribution }],
                },
              }],
            },
          }));
          ok(`CNAME → Route 53: ${SLUG}.${DOMAIN} → ${cfDistribution}`);
        } else {
          ok(`CNAME already in Route 53`);
        }
        cnameFixed = true;
      } catch (err) { warn(`CNAME failed: ${err.message}`); }
    }

    if (domainStatus === 'AVAILABLE') {
      console.log('');
      ok(`Domain AVAILABLE: ${c.g(BRANDED_URL)}`);
      break;
    }
  } catch { /* retry */ }
  await new Promise(r => setTimeout(r, 15_000));
}

// ─── Verify HTTP 200 ──────────────────────────────────────────────────────────
step(10, `Verify HTTP 200`);
info(`Checking ${BRANDED_URL} (up to 5 min)…`);

let httpOk = false;
let lastStatus = 0;
let pageTitle  = '';
const httpStart = Date.now();

for (let attempt = 0; attempt < 20; attempt++) {
  if (attempt > 0) {
    const elapsed = Math.round((Date.now() - httpStart) / 1000);
    wait(`HTTP attempt ${attempt + 1}/20 — last: ${lastStatus || 'error'} (${elapsed}s)…`);
    await new Promise(r => setTimeout(r, 15_000));
  }
  try {
    const res = await fetch(BRANDED_URL, {
      method: 'GET', redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'DWOMOH-Vibe-Code-Verifier/2.0' },
    });
    lastStatus = res.status;
    if (res.status === 200 || res.status === 304) {
      const html = await res.text().catch(() => '');
      pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
      httpOk = true;
      console.log('');
      ok(`${c.g('HTTP 200 OK')} — "${pageTitle}"`);
      break;
    }
  } catch { lastStatus = 0; }
}

if (!httpOk) {
  console.log('');
  warn(`HTTP: ${lastStatus} after 5 min — app may still be warming up`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(httpOk ? c.b(c.g(`\n✓ LIVE AND VERIFIED (genuine SSR)\n`)) : c.b(c.y(`\n⚠ Deployed — HTTP warming up\n`)));
console.log(`  ${c.b('Project:')}     ${PROJECT_NAME}`);
console.log(`  ${c.b('CodeCommit:')}  ${REPO_NAME}`);
console.log(`  ${c.b('Amplify ID:')}  ${APP_ID}`);
console.log(`  ${c.b('Branded URL:')} ${c.cy(BRANDED_URL)}`);
console.log(`  ${c.b('Domain:')}      ${domainStatus}`);
console.log(`  ${c.b('HTTP:')}        ${httpOk ? c.g('200 OK') : c.y(String(lastStatus || 'pending'))}`);
if (pageTitle) console.log(`  ${c.b('Page Title:')}  "${pageTitle}"`);
console.log('');
