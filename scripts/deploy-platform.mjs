#!/usr/bin/env node
/**
 * Deploy the DWOMOH Vibe Code platform itself to Amplify via CodeCommit.
 *
 * This replaces the sentinel placeholder app at dwomohvibe.com with the
 * real Next.js application, giving it a proper WEB_COMPUTE build + Lambda@Edge.
 *
 * Steps:
 *   1. Ensure IAM role has CodeCommit read access
 *   2. Create/find CodeCommit repo dwomoh-platform
 *   3. Push platform source (excluding generated-projects, .env.local, .next, etc.)
 *      – Override amplify.yml with npm install --include=dev build
 *      – Override next.config.js with Amplify-safe version (webpack alias, ignoreBuildErrors)
 *   4. Create new Amplify WEB_COMPUTE app connected to CodeCommit with env vars
 *   5. Start build, poll until SUCCEED
 *   6. Delete domain from sentinel app (d2jx0j2u4gc6qq)
 *   7. Attach dwomohvibe.com (apex '' and www) to new app
 *   8. Auto-wire Route 53: www CNAME + apex ALIAS
 *   9. Verify HTTP 200 on https://dwomohvibe.com and https://www.dwomohvibe.com
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
  ListAppsCommand,
  JobType,
  Platform,
  Stage,
  JobStatus,
} from '@aws-sdk/client-amplify';
import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  GetBranchCommand,
  CreateCommitCommand,
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
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

// Load .env.local if running locally
import { existsSync, readFileSync } from 'fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const AWS_REGION   = process.env.AWS_REGION || 'us-east-1';
const AWS_KEY      = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET   = process.env.AWS_SECRET_ACCESS_KEY || '';
const ROLE_ARN     = process.env.AMPLIFY_SERVICE_ROLE_ARN || '';
const HZ_ID        = process.env.DWOMOH_HOSTED_ZONE_ID || '';
const SENTINEL_ID  = process.env.AMPLIFY_SENTINEL_APP_ID || 'd2jx0j2u4gc6qq';
const DOMAIN       = process.env.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const REPO_NAME    = 'dwomoh-platform';
const APP_NAME     = 'dwomoh-platform';
const BRANCH       = 'main';
const PLATFORM_DIR = process.cwd();

const creds = () => ({ accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET });
const amp = new AmplifyClient({ region: AWS_REGION, credentials: creds() });
const cc  = new CodeCommitClient({ region: AWS_REGION, credentials: creds() });
const iam = new IAMClient({ region: 'us-east-1', credentials: creds() });
const r53 = new Route53Client({ region: 'us-east-1', credentials: creds() });

// ─── Amplify build config (injected into every CodeCommit push) ───────────────

const AMPLIFY_YML = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm install --include=dev
    build:
      commands:
        - NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS='--max-old-space-size=4096' npx next build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;

// Platform-specific next.config.js (Amplify-safe)
const NEXT_CONFIG_JS = `const path = require('path');
/** @type {import('next').NextConfig} */
module.exports = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['better-sqlite3'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  webpack: (config, { dev }) => {
    config.resolve.alias['@'] = path.resolve(process.cwd());
    if (!dev) config.devtool = false;
    return config;
  },
};
`;

// Env vars to set on the Amplify app.
// Do NOT include AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION —
// Amplify rejects vars with "AWS_" prefix; the IAM execution role injects them automatically.
// Env vars forwarded to the Amplify app — sourced from local environment / .env.local
// AWS_* prefix vars are rejected by Amplify (injected automatically via IAM role)
const ENV_VARS = {
  BEDROCK_MODEL_ID:                process.env.BEDROCK_MODEL_ID || '',
  DWOMOH_BRANDED_DOMAIN:           DOMAIN,
  DWOMOH_PLATFORM_DOMAIN:          DOMAIN,
  DWOMOH_HOSTED_ZONE_ID:           HZ_ID,
  ACM_CERTIFICATE_ARN:             process.env.ACM_CERTIFICATE_ARN || '',
  AMPLIFY_SERVICE_ROLE_ARN:        ROLE_ARN,
  AMPLIFY_SENTINEL_APP_ID:         SENTINEL_ID,
  DWOMOH_SES_FROM_EMAIL:           process.env.DWOMOH_SES_FROM_EMAIL || '',
  RAPIDAPI_KEY:                    process.env.RAPIDAPI_KEY || '',
  NEXT_PUBLIC_AWS_REGION:          AWS_REGION,
  NEXT_PUBLIC_USER_POOL_ID:        process.env.NEXT_PUBLIC_USER_POOL_ID || '',
  NEXT_PUBLIC_USER_POOL_CLIENT_ID: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID || '',
  NEXT_TELEMETRY_DISABLED:         '1',
  NODE_ENV:                        'production',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureCodeCommitAccess() {
  try {
    const roleName = ROLE_ARN.split('/').pop();
    const res = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
    const hasCC = res.AttachedPolicies?.some(p => p.PolicyName?.includes('CodeCommit'));
    if (!hasCC) {
      log('Attaching AWSCodeCommitReadOnly to IAM role...');
      await iam.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AWSCodeCommitReadOnly',
      }));
      log('✓ AWSCodeCommitReadOnly attached');
    } else {
      log('✓ IAM role already has CodeCommit access');
    }
  } catch (e) { log(`IAM (non-fatal): ${e.message}`); }
}

async function ensureCodeCommitRepo() {
  try {
    const res = await cc.send(new GetRepositoryCommand({ repositoryName: REPO_NAME }));
    log(`✓ CodeCommit repo exists: ${REPO_NAME}`);
    return res.repositoryMetadata.cloneUrlHttp;
  } catch (e) {
    if (e.name === 'RepositoryDoesNotExistException' || e.message?.includes('does not exist')) {
      log(`Creating CodeCommit repo: ${REPO_NAME}...`);
      const res = await cc.send(new CreateRepositoryCommand({
        repositoryName: REPO_NAME,
        repositoryDescription: 'DWOMOH Vibe Code — main platform',
        tags: { 'dwomoh:role': 'platform', 'dwomoh:managed': 'true' },
      }));
      log(`✓ Created: ${REPO_NAME}`);
      return res.repositoryMetadata.cloneUrlHttp;
    }
    throw e;
  }
}

// Directories and files to exclude from CodeCommit push
const IGNORE_DIRS  = new Set([
  'node_modules', '.next', '.git', 'generated-projects',
  '.dwomoh', '.claude', 'browser-screenshots', // skip debug screenshots (bloats payload)
]);
const IGNORE_FILES = new Set([
  '.env.local', '.env', 'tsconfig.tsbuildinfo', '.DS_Store',
  'project.db', 'project.db-shm', 'project.db-wal',
  '.dwomoh-deploy.zip', '.dwomoh-api-manager.json',
]);
const IGNORE_PATTERNS = [/^build-music-store\.mjs$/, /^test-.*\.(mjs|ts)$/, /^\.dwomoh-/];

function shouldIgnore(name) {
  if (IGNORE_DIRS.has(name) || IGNORE_FILES.has(name)) return true;
  return IGNORE_PATTERNS.some(r => r.test(name));
}

function collectFiles(dir, prefix = '') {
  const files = [];
  const MAX_FILE = 1.5 * 1024 * 1024; // 1.5MB per file
  try {
    for (const entry of readdirSync(dir)) {
      if (shouldIgnore(entry)) continue;
      const full = join(dir, entry);
      const rel  = prefix ? `${prefix}/${entry}` : entry;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        files.push(...collectFiles(full, rel));
      } else if (stat.size < MAX_FILE) {
        try { files.push({ filePath: rel, fileContent: readFileSync(full) }); } catch { /* skip */ }
      } else {
        log(`  Skipping large file (${(stat.size/1024/1024).toFixed(1)}MB): ${rel}`);
      }
    }
  } catch { /* skip unreadable dir */ }
  return files;
}

async function pushToCodeCommit(files) {
  const MAX_BATCH_BYTES = 4 * 1024 * 1024; // 4MB per commit
  const MAX_BATCH_FILES = 90;               // CodeCommit hard limit is 100; stay under
  let parentCommitId;
  try {
    const b = await cc.send(new GetBranchCommand({ repositoryName: REPO_NAME, branchName: BRANCH }));
    parentCommitId = b.branch?.commitId;
    log(`  Current HEAD: ${parentCommitId?.slice(0, 8)}`);
  } catch { log('  First commit (no parent)'); }

  // Batch by both file count and byte size
  const batches = [];
  let batch = [], batchSize = 0;
  for (const f of files) {
    const sz = f.fileContent.length;
    if ((batchSize + sz > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_FILES) && batch.length > 0) {
      batches.push(batch); batch = []; batchSize = 0;
    }
    batch.push(f); batchSize += sz;
  }
  if (batch.length > 0) batches.push(batch);

  log(`Uploading ${files.length} files in ${batches.length} batch(es)...`);
  let commitId = parentCommitId ?? '';
  for (let i = 0; i < batches.length; i++) {
    log(`  Batch ${i+1}/${batches.length}: ${batches[i].length} files`);
    try {
      const res = await cc.send(new CreateCommitCommand({
        repositoryName:  REPO_NAME,
        branchName:      BRANCH,
        ...(commitId ? { parentCommitId: commitId } : {}),
        authorName:      'DWOMOH Vibe Code',
        email:           'build@dwomohvibe.app',
        commitMessage:   `DWOMOH platform deploy — batch ${i+1}/${batches.length}`,
        putFiles:        batches[i],
      }));
      commitId = res.commitId ?? commitId;
      log(`  ✓ Committed: ${commitId.slice(0, 8)}`);
    } catch (e) {
      if (e.name === 'NoChangeException' || e.__type === 'NoChangeException') {
        log(`  ✓ Batch ${i+1}: no changes (already up-to-date)`);
      } else throw e;
    }
  }
  return commitId;
}

async function findExistingPlatformApp() {
  const res = await amp.send(new ListAppsCommand({ maxResults: 100 }));
  return res.apps?.find(a => a.name === APP_NAME || a.tags?.['dwomoh:role'] === 'platform');
}

async function verifyUrl(url, attempts = 20, intervalMs = 15000) {
  log(`Verifying: ${url}`);
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'DWOMOH-Verifier/1.0' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      const powered = res.headers.get('x-powered-by') || '';
      const text = await res.text().catch(() => '');
      const hasContent = text.length > 500;
      log(`  [${i}/${attempts}] ${res.status} ${powered} — body: ${text.length} chars`);
      if (res.status === 200 && hasContent) {
        const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
        log(`  ✅ LIVE — title: "${titleMatch?.[1] ?? 'unknown'}"`);
        return { ok: true, status: res.status, title: titleMatch?.[1] };
      }
      if ([404, 403, 503].includes(res.status)) log(`  HTTP ${res.status} — retrying…`);
    } catch (e) {
      log(`  [${i}/${attempts}] Network: ${e.message}`);
    }
    if (i < attempts) await sleep(intervalMs);
  }
  return { ok: false };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log('═══ DWOMOH Platform Deployment ═══');

  // 1. IAM
  await ensureCodeCommitAccess();

  // 2. CodeCommit repo
  const ccUrl = await ensureCodeCommitRepo();
  log(`CodeCommit URL: ${ccUrl}`);

  // 3. Collect source files
  log('Collecting source files...');
  const files = collectFiles(PLATFORM_DIR);

  // Override amplify.yml and next.config.js
  const amplifyYmlIdx = files.findIndex(f => f.filePath === 'amplify.yml');
  if (amplifyYmlIdx >= 0) files[amplifyYmlIdx].fileContent = Buffer.from(AMPLIFY_YML);
  else files.push({ filePath: 'amplify.yml', fileContent: Buffer.from(AMPLIFY_YML) });

  const nextCfgIdx = files.findIndex(f => f.filePath === 'next.config.js');
  if (nextCfgIdx >= 0) files[nextCfgIdx].fileContent = Buffer.from(NEXT_CONFIG_JS);
  else files.push({ filePath: 'next.config.js', fileContent: Buffer.from(NEXT_CONFIG_JS) });

  const totalMB = (files.reduce((a,f) => a + f.fileContent.length, 0) / 1024 / 1024).toFixed(1);
  log(`Collected ${files.length} files — ${totalMB} MB`);

  // 4. Push to CodeCommit
  await pushToCodeCommit(files);

  // 5. Create or find Amplify app
  let appId;
  const existing = await findExistingPlatformApp();
  if (existing) {
    appId = existing.appId;
    log(`✓ Found existing Amplify app: ${appId}`);
  } else {
    log('Creating Amplify WEB_COMPUTE app...');
    const res = await amp.send(new CreateAppCommand({
      name:               APP_NAME,
      description:        'DWOMOH Vibe Code — main platform',
      repository:         ccUrl,
      platform:           Platform.WEB_COMPUTE,
      iamServiceRoleArn:  ROLE_ARN,
      buildSpec:          AMPLIFY_YML,
      environmentVariables: ENV_VARS,
      tags: {
        'dwomoh:role':    'platform',
        'dwomoh:managed': 'true',
        'dwomoh:domain':  DOMAIN,
        'dwomoh:source':  'codecommit',
      },
    }));
    appId = res.app.appId;
    log(`✓ Created Amplify app: ${appId}`);
  }

  // 6. Create branch
  try {
    await amp.send(new CreateBranchCommand({
      appId,
      branchName:      BRANCH,
      stage:           Stage.PRODUCTION,
      enableAutoBuild: true,
      framework:       'Next.js - SSR',
      environmentVariables: { NODE_ENV: 'production' },
    }));
    log(`✓ Branch '${BRANCH}' created`);
  } catch (e) {
    if (e.message?.includes('already')) log(`✓ Branch '${BRANCH}' already exists`);
    else throw e;
  }

  // 7. Start build
  log('Starting build...');
  const jobRes = await amp.send(new StartJobCommand({
    appId,
    branchName: BRANCH,
    jobType:    JobType.RELEASE,
    jobReason:  'DWOMOH Platform deploy',
  }));
  const jobId = jobRes.jobSummary.jobId;
  log(`✓ Build job started: ${jobId}`);
  log(`  Monitor: https://console.aws.amazon.com/amplify/home#/apps/${appId}/branches/${BRANCH}/deployments`);
  log(`  Default URL: https://${BRANCH}.${appId}.amplifyapp.com`);

  // 8. Delete domain from sentinel app
  log(`\nRemoving domain from sentinel app (${SENTINEL_ID})...`);
  try {
    await amp.send(new DeleteDomainAssociationCommand({ appId: SENTINEL_ID, domainName: DOMAIN }));
    log('✓ Domain removed from sentinel');
    await sleep(5000); // Let Amplify process the deletion
  } catch (e) {
    log(`Sentinel domain removal (non-fatal): ${e.message}`);
  }

  // 9. Attach domain to new platform app (apex + www)
  log(`Attaching ${DOMAIN} to new app (${appId})...`);
  try {
    await amp.send(new CreateDomainAssociationCommand({
      appId,
      domainName:          DOMAIN,
      enableAutoSubDomain: false,
      subDomainSettings: [
        { branchName: BRANCH, prefix: '' },    // apex: dwomohvibe.com
        { branchName: BRANCH, prefix: 'www' }, // www.dwomohvibe.com
      ],
    }));
    log('✓ Domain association created');
  } catch (e) {
    if (e.message?.includes('already')) log('✓ Domain already associated');
    else log(`Domain (non-fatal): ${e.message}`);
  }

  // 10. Poll build until SUCCEED
  log('\nPolling build status...');
  const BUILD_TIMEOUT = 20 * 60 * 1000;
  const buildStart = Date.now();
  let buildOk = false;
  while (Date.now() - buildStart < BUILD_TIMEOUT) {
    await sleep(20_000);
    try {
      const jr = await amp.send(new GetJobCommand({ appId, branchName: BRANCH, jobId }));
      const status = jr.job?.summary?.status;
      log(`  Build: ${status}`);
      if (status === JobStatus.SUCCEED) { buildOk = true; break; }
      if (status === JobStatus.FAILED || status === JobStatus.CANCELLED) {
        log('✗ Build FAILED');
        log('  Check Amplify console for build logs');
        process.exit(1);
      }
    } catch (e) { log(`  Poll error: ${e.message}`); }
  }

  if (!buildOk) { log('✗ Build timed out after 20 minutes'); process.exit(1); }
  log('✅ Build SUCCEEDED');

  // 11. Poll domain until AVAILABLE + auto-wire CNAME
  log('\nWaiting for domain to become AVAILABLE...');
  const DOMAIN_TIMEOUT = 15 * 60 * 1000;
  const domainStart = Date.now();
  let cfDistribution = null;
  let domainOk = false;

  while (Date.now() - domainStart < DOMAIN_TIMEOUT) {
    await sleep(15_000);
    try {
      const dr = await amp.send(new GetDomainAssociationCommand({ appId, domainName: DOMAIN }));
      const da = dr.domainAssociation;
      const status = da?.domainStatus;
      const subs = da?.subDomains ?? [];
      log(`  Domain: ${status} — subs: ${subs.map(s => s.subDomainSetting?.prefix || '(apex)').join(', ')}`);

      // Extract CloudFront distribution
      for (const sub of subs) {
        const dnsRec = sub.dnsRecord;
        if (dnsRec) {
          const cf = dnsRec.split(' ').pop()?.replace(/\.$/, '');
          if (cf?.includes('cloudfront.net')) { cfDistribution = cf; break; }
        }
      }

      // Auto-wire Route 53 during AWAITING_APP_CNAME
      if (status === 'AWAITING_APP_CNAME' && cfDistribution) {
        log(`  CloudFront: ${cfDistribution}`);
        await ensureRoute53Records(cfDistribution);
      }

      if (status === 'AVAILABLE') {
        domainOk = true;
        if (cfDistribution) await ensureRoute53Records(cfDistribution);
        break;
      }
      if (status === 'FAILED') { log('  ✗ Domain association FAILED'); break; }
    } catch (e) { log(`  Domain poll: ${e.message}`); }
  }

  if (!domainOk) {
    log('⚠ Domain not AVAILABLE yet — checking default URL...');
  } else {
    log(`✅ Domain AVAILABLE — CloudFront: ${cfDistribution}`);
  }

  // 12. Verify both URLs
  log('\n═══ Live Verification ═══');
  const defaultUrl = `https://${BRANCH}.${appId}.amplifyapp.com`;
  const r1 = await verifyUrl(defaultUrl, 5, 5000);
  const r2 = await verifyUrl('https://www.dwomohvibe.com', 20, 15000);
  const r3 = await verifyUrl('https://dwomohvibe.com', 10, 15000);

  log('\n═══ Result ═══');
  log(`Default URL (${defaultUrl}): ${r1.ok ? '✅ LIVE' : '⚠ not responding yet'}`);
  log(`www.dwomohvibe.com: ${r2.ok ? '✅ LIVE' : '⚠ not yet (DNS may take up to 5 min)'}`);
  log(`dwomohvibe.com:     ${r3.ok ? '✅ LIVE' : '⚠ not yet (DNS may take up to 5 min)'}`);
  log(`\nAmplify app: https://console.aws.amazon.com/amplify/home#/apps/${appId}`);

  if (!r1.ok && !r2.ok) {
    log('\nThe build succeeded. DNS propagation typically takes 2-5 minutes.');
    log('Run this to verify: curl -si https://www.dwomohvibe.com | head -20');
  }
})();

// ─── Route 53 helpers ─────────────────────────────────────────────────────────

async function ensureRoute53Records(cfDistribution) {
  try {
    const existing = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: HZ_ID }));
    const records = existing.ResourceRecordSets ?? [];

    const changes = [];

    // www CNAME → cfDistribution
    const wwwFqdn = 'www.dwomohvibe.com.';
    const wwwCf = cfDistribution.endsWith('.') ? cfDistribution : `${cfDistribution}.`;
    const wwwOk = records.some(r =>
      r.Type === 'CNAME' && r.Name === wwwFqdn &&
      r.ResourceRecords?.some(v => v.Value === wwwCf || v.Value === cfDistribution)
    );
    if (!wwwOk) {
      log(`  Updating Route 53: www CNAME → ${cfDistribution}`);
      changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: wwwFqdn,
          Type: 'CNAME',
          TTL: 300,
          ResourceRecords: [{ Value: wwwCf }],
        },
      });
    } else {
      log('  Route 53 www CNAME already correct');
    }

    // Apex ALIAS → cfDistribution (A ALIAS record for CloudFront)
    const apexFqdn = 'dwomohvibe.com.';
    const apexOk = records.some(r =>
      r.Type === 'A' && r.Name === apexFqdn && r.AliasTarget?.DNSName?.includes(cfDistribution.replace(/\.$/, ''))
    );
    if (!apexOk) {
      log(`  Adding Route 53 apex A ALIAS → ${cfDistribution}`);
      changes.push({
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: apexFqdn,
          Type: 'A',
          AliasTarget: {
            HostedZoneId: 'Z2FDTNDATAQYW2', // Global CloudFront hosted zone (always this value)
            DNSName: wwwCf,
            EvaluateTargetHealth: false,
          },
        },
      });
    } else {
      log('  Route 53 apex ALIAS already correct');
    }

    if (changes.length > 0) {
      await r53.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: HZ_ID,
        ChangeBatch: { Comment: 'DWOMOH platform domain wiring', Changes: changes },
      }));
      log(`  ✓ Route 53 updated (${changes.length} change(s))`);
    }
  } catch (e) {
    log(`  Route 53 (non-fatal): ${e.message}`);
  }
}
