#!/usr/bin/env node
/**
 * DWOMOH Vibe Code — Test Deployment Script
 * Deploys a generated project to Amplify and maps {slug}.dwomohvibe.com
 *
 * Usage: node scripts/deploy-test.mjs [project-dir-name]
 * Example: node scripts/deploy-test.mjs adepas-collection
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_NAME = process.argv[2] || 'adepas-collection';
const PROJECT_DIR  = join(ROOT, 'generated-projects', PROJECT_NAME);

if (!existsSync(PROJECT_DIR)) {
  console.error(`Project not found: ${PROJECT_DIR}`);
  process.exit(1);
}

// ─── Load env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const ENV    = loadEnv();
const creds  = { accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY };
const DOMAIN = ENV.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const ROLE   = ENV.AMPLIFY_SERVICE_ROLE_ARN;
const REGION = ENV.AWS_REGION || 'us-east-1';

const c = {
  g:  s => `\x1b[32m${s}\x1b[0m`,
  y:  s => `\x1b[33m${s}\x1b[0m`,
  r:  s => `\x1b[31m${s}\x1b[0m`,
  cy: s => `\x1b[36m${s}\x1b[0m`,
  b:  s => `\x1b[1m${s}\x1b[0m`,
  d:  s => `\x1b[2m${s}\x1b[0m`,
};

const step = (n, label) => console.log(`\n${c.b(c.cy(`── Step ${n}:`))} ${c.b(label)}`);
const ok   = msg => console.log(`  ${c.g('✓')} ${msg}`);
const info = msg => console.log(`  ${c.d(msg)}`);
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

// ─── AWS SDK imports ─────────────────────────────────────────────────────────
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
  JobStatus,
} = await import('@aws-sdk/client-amplify');

const ampCli = new AmplifyClient({ region: REGION, credentials: creds });

// ─── Package project ─────────────────────────────────────────────────────────
step(1, `Package: ${PROJECT_NAME} → ${SLUG}.${DOMAIN}`);
info(`Project dir: ${PROJECT_DIR}`);

const { zipSync } = await import('fflate');

const IGNORE = new Set(['node_modules', '.next', '.git', 'generated-projects', '.env.local', '.env', '.dwomoh-deploy.zip', 'project.db', 'project.db-shm', 'project.db-wal']);
const files = {};
let fileCount = 0;
let totalSize = 0;

function collect(dir, prefix) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    const rel  = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collect(full, rel);
    } else if (stat.size < 5 * 1024 * 1024) {
      try {
        files[rel] = readFileSync(full);
        fileCount++;
        totalSize += stat.size;
      } catch { /* skip locked files */ }
    }
  }
}

collect(PROJECT_DIR, '');
info(`Collected ${fileCount} files (${(totalSize / 1024).toFixed(0)} KB)`);

const zipped   = zipSync(files, { level: 6 });
const ZIP_PATH = join(PROJECT_DIR, '.dwomoh-deploy.zip');
writeFileSync(ZIP_PATH, zipped);
ok(`Zip created: ${(zipped.length / 1024).toFixed(0)} KB`);

// ─── Find or create Amplify app ───────────────────────────────────────────────
step(2, `Amplify App`);

let APP_ID = null;
const listRes = await ampCli.send(new ListAppsCommand({ maxResults: 100 }));
const existing = listRes.apps?.find(a => a.tags?.['dwomoh:projectId'] === PROJECT_ID);

if (existing) {
  APP_ID = existing.appId;
  ok(`Using existing Amplify app: ${APP_ID}`);
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
    },
    buildSpec: `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci --prefer-offline
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
      - node_modules/**/*`,
    tags: {
      'dwomoh:projectId': PROJECT_ID,
      'dwomoh:projectName': PROJECT_NAME,
      'dwomoh:slug': SLUG,
      'dwomoh:managed': 'true',
    },
  }));
  APP_ID = createRes.app.appId;
  ok(`App created: ${APP_ID}`);
}

// ─── Create branch ────────────────────────────────────────────────────────────
step(3, `Branch: main`);

try {
  await ampCli.send(new CreateBranchCommand({
    appId: APP_ID,
    branchName: 'main',
    stage: 'PRODUCTION',
    enableAutoBuild: false,
    framework: 'Next.js - SSR',
  }));
  ok(`Branch 'main' created`);
} catch (e) {
  if (e.message?.includes('already')) {
    ok(`Branch 'main' already exists`);
  } else {
    throw e;
  }
}

// ─── Create deployment slot (get signed S3 URL) ───────────────────────────────
step(4, `Upload to Amplify`);

info(`Requesting deployment slot…`);
const deploySlot = await ampCli.send(new CreateDeploymentCommand({
  appId: APP_ID,
  branchName: 'main',
}));

const jobId      = deploySlot.jobId;
const uploadUrl  = deploySlot.zipUploadUrl;

info(`Job ID: ${jobId}`);
info(`Uploading ${(zipped.length / 1024).toFixed(0)} KB zip…`);

const uploadRes = await fetch(uploadUrl, {
  method: 'PUT',
  body: zipped,
  headers: { 'Content-Type': 'application/zip' },
});

if (!uploadRes.ok) {
  console.error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
  process.exit(1);
}
ok(`Uploaded successfully`);

// ─── Start build ─────────────────────────────────────────────────────────────
step(5, `Start Amplify Build`);

await ampCli.send(new StartDeploymentCommand({
  appId: APP_ID,
  branchName: 'main',
  jobId,
}));
ok(`Build started (Job: ${jobId})`);

// ─── Poll build status ────────────────────────────────────────────────────────
step(6, `Wait for Build Completion`);
info(`This typically takes 3–8 minutes for a Next.js app…`);

const startTime = Date.now();
let buildStatus = '';

while (Date.now() - startTime < 15 * 60 * 1000) {
  const jobRes = await ampCli.send(new GetJobCommand({
    appId: APP_ID,
    branchName: 'main',
    jobId,
  }));

  buildStatus = jobRes.job?.summary?.status ?? 'UNKNOWN';
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  wait(`Build status: ${buildStatus} (${elapsed}s elapsed)…`);

  if (buildStatus === JobStatus.SUCCEED) {
    console.log('');
    ok(`Build succeeded in ${elapsed}s`);
    break;
  }
  if (buildStatus === JobStatus.FAILED || buildStatus === JobStatus.CANCELLED) {
    console.log('');
    console.error(`  ✗ Build ${buildStatus}`);
    console.log(`  Check Amplify Console for logs: https://us-east-1.console.aws.amazon.com/amplify/home#/${APP_ID}/d/${jobId}`);
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 15_000));
}

if (buildStatus !== JobStatus.SUCCEED) {
  console.log('');
  console.error(`  ✗ Build timed out after 15 minutes`);
  process.exit(1);
}

// ─── Attach branded subdomain ─────────────────────────────────────────────────
step(7, `Attach Domain: ${SLUG}.${DOMAIN}`);

try {
  await ampCli.send(new CreateDomainAssociationCommand({
    appId: APP_ID,
    domainName: DOMAIN,
    subDomainSettings: [{ branchName: 'main', prefix: SLUG }],
    enableAutoSubDomain: false,
  }));
  ok(`Domain association requested: ${SLUG}.${DOMAIN}`);
} catch (e) {
  if (e.message?.includes('already') || e.name === 'DomainAssociationAlreadyExistsException') {
    ok(`Domain association already exists`);
  } else {
    console.log(`  ⚠ Domain association: ${e.message}`);
    console.log(`  The app is live via Amplify default URL. Branded URL will be added separately.`);
  }
}

// Poll domain status
info(`Waiting for domain association to activate…`);
let domainStatus = '';
const domainStart = Date.now();

while (Date.now() - domainStart < 5 * 60 * 1000) {
  try {
    const assocRes = await ampCli.send(new GetDomainAssociationCommand({
      appId: APP_ID,
      domainName: DOMAIN,
    }));
    const da = assocRes.domainAssociation;

    // Look for our specific subdomain
    const ourSub = da?.subDomains?.find(s => s.subDomainSetting?.prefix === SLUG);
    domainStatus = ourSub ? (da?.domainStatus ?? '') : (da?.domainStatus ?? '');

    const elapsed = Math.round((Date.now() - domainStart) / 1000);
    wait(`Domain status: ${domainStatus} (${elapsed}s)…`);

    if (domainStatus === 'AVAILABLE') {
      console.log('');
      ok(`${c.g(SLUG + '.' + DOMAIN)} is live!`);
      break;
    }
  } catch { /* not ready yet */ }
  await new Promise(r => setTimeout(r, 10_000));
}
console.log('');

// ─── Summary ──────────────────────────────────────────────────────────────────
const defaultUrl = `https://main.${APP_ID}.amplifyapp.com`;
console.log(`${'─'.repeat(60)}`);
console.log(c.b(c.g(`\n✓ Deployment Complete!\n`)));
console.log(`  ${c.b('Project:')}    ${PROJECT_NAME}`);
console.log(`  ${c.b('Amplify ID:')} ${APP_ID}`);
console.log(`  ${c.b('Job ID:')}     ${jobId}`);
console.log(`  ${c.b('Build:')}      ${buildStatus}`);
console.log(`  ${c.b('Branded URL:')} ${c.cy(BRANDED_URL)}`);
console.log(`  ${c.b('Domain:')}     ${domainStatus || 'Activating…'}`);
console.log(`\n  Open: ${BRANDED_URL}\n`);

if (domainStatus !== 'AVAILABLE') {
  console.log(c.y(`  Note: Domain is still activating. Check in a few minutes:`));
  console.log(c.y(`  node scripts/status-check.mjs`));
  console.log(c.y(`  Direct Amplify URL (works now): ${defaultUrl}`));
}
