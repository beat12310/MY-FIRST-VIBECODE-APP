#!/usr/bin/env node
/**
 * DWOMOH Vibe Code — Standalone Deploy
 *
 * Packages a pre-built Next.js standalone output and deploys it to Amplify.
 * Manual zip deployment skips the buildSpec, so we must supply a runnable
 * artifact: .next/standalone/ + .next/static/ + public/
 *
 * Usage:
 *   node scripts/deploy-standalone.mjs [project-dir-name]
 *   node scripts/deploy-standalone.mjs adepas-collection
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT         = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_NAME = process.argv[2] || 'adepas-collection';
const PROJECT_DIR  = join(ROOT, 'generated-projects', PROJECT_NAME);

if (!existsSync(PROJECT_DIR)) {
  console.error(`Project not found: ${PROJECT_DIR}`);
  process.exit(1);
}

const STANDALONE_DIR = join(PROJECT_DIR, '.next', 'standalone');
const STATIC_DIR     = join(PROJECT_DIR, '.next', 'static');
const PUBLIC_DIR     = join(PROJECT_DIR, 'public');

if (!existsSync(STANDALONE_DIR)) {
  console.error(`No standalone output found at ${STANDALONE_DIR}`);
  console.error(`Run: cd ${PROJECT_DIR} && npm run build`);
  process.exit(1);
}

// ─── Load env ────────────────────────────────────────────────────────────────
const raw = readFileSync(join(ROOT, '.env.local'), 'utf-8');
const ENV = {};
for (const line of raw.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  ENV[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const creds  = { accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY };
const DOMAIN = ENV.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const ROLE   = ENV.AMPLIFY_SERVICE_ROLE_ARN;
const REGION = ENV.AWS_REGION || 'us-east-1';
const HZ_ID  = ENV.DWOMOH_HOSTED_ZONE_ID;

const c = {
  g:   s => `\x1b[32m${s}\x1b[0m`,
  y:   s => `\x1b[33m${s}\x1b[0m`,
  r:   s => `\x1b[31m${s}\x1b[0m`,
  cy:  s => `\x1b[36m${s}\x1b[0m`,
  b:   s => `\x1b[1m${s}\x1b[0m`,
  d:   s => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, label) => console.log(`\n${c.b(c.cy(`── Step ${n}:`))} ${c.b(label)}`);
const ok   = msg => console.log(`  ${c.g('✓')} ${msg}`);
const info = msg => console.log(`  ${c.d(msg)}`);
const warn = msg => console.log(`  ${c.y('⚠')} ${msg}`);
const wait = msg => process.stdout.write(`  ⏳ ${msg}\r`);

// ─── Slugify ─────────────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

const SLUG        = slugify(PROJECT_NAME);
const BRANDED_URL = `https://${SLUG}.${DOMAIN}`;
const PROJECT_ID  = `proj-${SLUG}`;

// ─── AWS imports ──────────────────────────────────────────────────────────────
const {
  AmplifyClient,
  CreateAppCommand,
  ListAppsCommand,
  CreateBranchCommand,
  CreateDeploymentCommand,
  StartDeploymentCommand,
  GetJobCommand,
  CreateDomainAssociationCommand,
  GetDomainAssociationCommand,
  UpdateAppCommand,
  JobStatus,
} = await import('@aws-sdk/client-amplify');

const {
  Route53Client,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
} = await import('@aws-sdk/client-route-53');

const ampCli = new AmplifyClient({ region: REGION, credentials: creds });
const r53    = new Route53Client({ region: 'us-east-1', credentials: creds });

// ─── Package standalone output ────────────────────────────────────────────────
step(1, `Package standalone output: ${PROJECT_NAME}`);
info(`Standalone dir: ${STANDALONE_DIR}`);

const { zipSync } = await import('fflate');
const files = {};
let fileCount = 0;
let totalSize = 0;

const SKIP_EXTS = new Set(['.db', '.db-shm', '.db-wal', '.log']);
const MAX_FILE  = 5 * 1024 * 1024; // 5MB per file

function collect(dir, prefix) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel  = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collect(full, rel);
    } else {
      const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if (stat.size > MAX_FILE) { info(`Skipping large file (${(stat.size/1024/1024).toFixed(1)}MB): ${rel}`); continue; }
      try {
        files[rel] = readFileSync(full);
        fileCount++;
        totalSize += stat.size;
      } catch { /* skip locked files */ }
    }
  }
}

// 1. Core: contents of .next/standalone/  (includes server.js, node_modules, .next/server)
collect(STANDALONE_DIR, '');

// 2. Static assets: .next/static/ → .next/static/ (must live here for _next/static routes)
if (existsSync(STATIC_DIR)) {
  collect(STATIC_DIR, '.next/static');
}

// 3. Public dir (if it exists)
if (existsSync(PUBLIC_DIR)) {
  collect(PUBLIC_DIR, 'public');
}

info(`Collected ${fileCount} files (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);

const zipped  = zipSync(files, { level: 6 });
const ZIP_PATH = join(PROJECT_DIR, '.dwomoh-deploy.zip');
writeFileSync(ZIP_PATH, zipped);
ok(`Zip created: ${(zipped.length / 1024 / 1024).toFixed(1)} MB`);

// ─── Find or create Amplify app ───────────────────────────────────────────────
step(2, `Amplify App`);

let APP_ID = null;
const listRes  = await ampCli.send(new ListAppsCommand({ maxResults: 100 }));
const existing = listRes.apps?.find(a => a.tags?.['dwomoh:projectId'] === PROJECT_ID);

if (existing) {
  APP_ID = existing.appId;
  ok(`Using existing Amplify app: ${APP_ID}`);

  // Ensure platform is WEB_COMPUTE
  if (existing.platform !== 'WEB_COMPUTE') {
    await ampCli.send(new UpdateAppCommand({ appId: APP_ID, platform: 'WEB_COMPUTE' }));
    ok(`Updated platform → WEB_COMPUTE`);
  }
} else {
  info(`Creating new Amplify app for ${PROJECT_NAME}…`);
  const createRes = await ampCli.send(new CreateAppCommand({
    name: `dwomoh-${SLUG}`,
    description: `DWOMOH Vibe Code — ${PROJECT_NAME}`,
    platform: 'WEB_COMPUTE',
    iamServiceRoleArn: ROLE,
    environmentVariables: {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: '3000',
    },
    customHeaders: `customHeaders:
  - pattern: '**/*'
    headers:
      - key: 'Cache-Control'
        value: 'public, max-age=0, s-maxage=31536000'
  - pattern: '_next/static/**/*'
    headers:
      - key: 'Cache-Control'
        value: 'public, max-age=31536000, immutable'`,
    tags: {
      'dwomoh:projectId':   PROJECT_ID,
      'dwomoh:projectName': PROJECT_NAME,
      'dwomoh:slug':        SLUG,
      'dwomoh:managed':     'true',
    },
  }));
  APP_ID = createRes.app.appId;
  ok(`App created: ${APP_ID}`);
}

// ─── Create/ensure branch ─────────────────────────────────────────────────────
step(3, `Branch: main`);

try {
  await ampCli.send(new CreateBranchCommand({
    appId: APP_ID,
    branchName: 'main',
    stage: 'PRODUCTION',
    enableAutoBuild: false,
    framework: 'Next.js - SSR',
    environmentVariables: { NODE_ENV: 'production' },
  }));
  ok(`Branch 'main' created`);
} catch (e) {
  if (e.message?.includes('already') || e.name?.includes('AlreadyExists')) {
    ok(`Branch 'main' already exists`);
  } else throw e;
}

// ─── Upload to Amplify ────────────────────────────────────────────────────────
step(4, `Upload standalone package`);

info(`Requesting deployment slot…`);
const deploySlot = await ampCli.send(new CreateDeploymentCommand({
  appId: APP_ID,
  branchName: 'main',
}));

const jobId     = deploySlot.jobId;
const uploadUrl = deploySlot.zipUploadUrl;
info(`Job ID: ${jobId}`);
info(`Uploading ${(zipped.length / 1024 / 1024).toFixed(1)} MB…`);

const uploadRes = await fetch(uploadUrl, {
  method: 'PUT',
  body: zipped,
  headers: { 'Content-Type': 'application/zip' },
});
if (!uploadRes.ok) {
  console.error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
  process.exit(1);
}
ok(`Uploaded to S3`);

// ─── Start deployment ─────────────────────────────────────────────────────────
step(5, `Start Deployment`);

await ampCli.send(new StartDeploymentCommand({
  appId: APP_ID,
  branchName: 'main',
  jobId,
}));
ok(`Deployment started (Job: ${jobId})`);

// ─── Poll until deployed ──────────────────────────────────────────────────────
step(6, `Wait for Deployment`);

const startTime = Date.now();
let buildStatus = '';

while (Date.now() - startTime < 5 * 60 * 1000) {
  const jobRes = await ampCli.send(new GetJobCommand({
    appId: APP_ID, branchName: 'main', jobId,
  }));
  buildStatus = jobRes.job?.summary?.status ?? 'UNKNOWN';
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  wait(`Status: ${buildStatus} (${elapsed}s)…`);

  if (buildStatus === JobStatus.SUCCEED) {
    console.log('');
    ok(`Deployment succeeded in ${elapsed}s`);
    break;
  }
  if (buildStatus === JobStatus.FAILED || buildStatus === JobStatus.CANCELLED) {
    console.log('');
    console.error(`  ✗ Deployment ${buildStatus}`);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 10_000));
}

// ─── Attach branded subdomain ─────────────────────────────────────────────────
step(7, `Attach Domain: ${SLUG}.${DOMAIN}`);

let cfDistribution = null;

try {
  await ampCli.send(new CreateDomainAssociationCommand({
    appId: APP_ID,
    domainName: DOMAIN,
    subDomainSettings: [{ branchName: 'main', prefix: SLUG }],
    enableAutoSubDomain: false,
  }));
  ok(`Domain association requested`);
} catch (e) {
  if (e.message?.includes('already') || e.name?.includes('AlreadyExists')) {
    ok(`Domain association already exists`);
  } else {
    warn(`Domain association: ${e.message}`);
  }
}

// ─── Poll domain + auto-fix CNAME ────────────────────────────────────────────
step(8, `Wait for Domain + Auto-wire CNAME`);
info(`Polling domain status (up to 10 min)…`);

let domainStatus = '';
let cnameFixed   = false;
const domainStart = Date.now();

while (Date.now() - domainStart < 10 * 60 * 1000) {
  try {
    const res = await ampCli.send(new GetDomainAssociationCommand({
      appId: APP_ID, domainName: DOMAIN,
    }));
    const da = res.domainAssociation;
    domainStatus = da?.domainStatus ?? '';
    cfDistribution = da?.domainAssociation?.certificateVerificationDNSRecord
      ? da?.domainAssociation?.certificateVerificationDNSRecord
      : cfDistribution;

    // Grab CF distribution from subdomain DNS records
    const sub = da?.subDomains?.find(s => s.subDomainSetting?.prefix === SLUG);
    const subDns = sub?.dnsRecord;
    if (subDns && subDns.includes('cloudfront.net')) {
      const parts = subDns.split(/\s+/);
      cfDistribution = parts.find(p => p.includes('cloudfront.net'))?.replace(/\.$/, '') ?? cfDistribution;
    }

    const elapsed = Math.round((Date.now() - domainStart) / 1000);
    wait(`Domain: ${domainStatus} (${elapsed}s) CF: ${cfDistribution ?? 'pending'}…`);

    // Auto-add CNAME when Amplify needs it
    if ((domainStatus === 'AWAITING_APP_CNAME' || domainStatus === 'PENDING_DEPLOYMENT') && cfDistribution && HZ_ID && !cnameFixed) {
      console.log('');
      info(`Auto-wiring CNAME: ${SLUG}.${DOMAIN} → ${cfDistribution}`);
      try {
        // Check if CNAME already exists
        const existing = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: HZ_ID }));
        const cnameRecord = existing.ResourceRecordSets?.find(
          r => r.Type === 'CNAME' && r.Name?.startsWith(SLUG)
        );
        if (!cnameRecord) {
          await r53.send(new ChangeResourceRecordSetsCommand({
            HostedZoneId: HZ_ID,
            ChangeBatch: {
              Comment: `DWOMOH Vibe Code auto-wire: ${SLUG}`,
              Changes: [{
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: `${SLUG}.${DOMAIN}`,
                  Type: 'CNAME',
                  TTL: 300,
                  ResourceRecords: [{ Value: cfDistribution }],
                },
              }],
            },
          }));
          ok(`CNAME added to Route 53: ${SLUG}.${DOMAIN} → ${cfDistribution}`);
        } else {
          ok(`CNAME already in Route 53`);
        }
        cnameFixed = true;
      } catch (err) {
        warn(`CNAME auto-wire failed: ${err.message}`);
      }
    }

    if (domainStatus === 'AVAILABLE') {
      console.log('');
      ok(`Domain AVAILABLE: ${c.g(BRANDED_URL)}`);
      break;
    }
  } catch { /* not ready yet */ }
  await new Promise(r => setTimeout(r, 15_000));
}

// ─── Verify HTTP ──────────────────────────────────────────────────────────────
step(9, `Verify HTTP 200`);
info(`Checking ${BRANDED_URL} (up to 5 min with retries)…`);

let httpOk = false;
let lastStatus = 0;
const httpStart = Date.now();

for (let attempt = 0; attempt < 20; attempt++) {
  if (attempt > 0) {
    const elapsed = Math.round((Date.now() - httpStart) / 1000);
    wait(`HTTP attempt ${attempt + 1}/20 — last: ${lastStatus || 'error'} (${elapsed}s)…`);
    await new Promise(r => setTimeout(r, 15_000));
  }
  try {
    const res = await fetch(BRANDED_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'DWOMOH-Vibe-Code-Verifier/2.0' },
    });
    lastStatus = res.status;
    if (res.status === 200 || res.status === 304) {
      httpOk = true;
      const html = await res.text().catch(() => '');
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
      console.log('');
      ok(`HTTP 200 OK — "${title}"`);
      break;
    }
  } catch (e) {
    lastStatus = 0;
  }
}

if (!httpOk) {
  console.log('');
  warn(`HTTP verification: ${lastStatus || 'error'} after 5 min`);
  warn(`The app may still be warming up. Try: node scripts/verify-deployment.mjs ${BRANDED_URL}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (httpOk) {
  console.log(c.b(c.g(`\n✓ DEPLOYMENT LIVE AND VERIFIED\n`)));
} else {
  console.log(c.b(c.y(`\n⚠ Deployment done — HTTP not yet 200\n`)));
}
console.log(`  ${c.b('Project:')}     ${PROJECT_NAME}`);
console.log(`  ${c.b('Amplify ID:')}  ${APP_ID}`);
console.log(`  ${c.b('Branded URL:')} ${c.cy(BRANDED_URL)}`);
console.log(`  ${c.b('Domain:')}      ${domainStatus || 'Unknown'}`);
console.log(`  ${c.b('CF:')}          ${cfDistribution ?? 'Unknown'}`);
console.log(`  ${c.b('HTTP:')}        ${httpOk ? c.g('200 OK') : c.y(String(lastStatus || 'pending'))}`);
console.log('');
