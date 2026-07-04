/**
 * End-to-end builder: generates the music store app, installs deps,
 * starts the dev server, and verifies the preview loads.
 * Run with: node build-music-store.mjs
 */

const BASE = 'http://localhost:3000/api/chat';

async function api(body, label) {
  const start = Date.now();
  process.stdout.write(`\n⏳ ${label}…`);
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000), // 3 min max per step
    });
    const data = await res.json();
    const ms = ((Date.now() - start) / 1000).toFixed(1);
    console.log(` done (${ms}s)`);
    return data;
  } catch (err) {
    console.log(` ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Step 1: Generate ──────────────────────────────────────────────────────────
console.log('\n🎵 Generating music store app like Boomplay…\n');
const PROMPT = `Build a music store app like Boomplay.
It should have:
- A homepage with featured albums and trending songs
- A song list with artist name, title, duration, play button
- A simple audio player bar at the bottom
- Mock data for at least 10 songs and 5 albums
- Dark theme with music-app styling
- An API route that returns the song catalog as JSON
- Authentication with next-auth (show login/logout button in header)
Use Next.js 15 App Router, TypeScript, and Tailwind CSS.
Do NOT use external music APIs — use hardcoded mock data.`;

const genData = await api(
  { action: 'generate', messages: [{ role: 'user', content: PROMPT }] },
  'Step 1: AI generating project files'
);

if (!genData?.success || !genData?.projectData) {
  console.error('❌ Generate failed:', JSON.stringify(genData).slice(0, 400));
  process.exit(1);
}
const { projectData } = genData;
console.log(`   📁 Project: ${projectData.projectName}`);
console.log(`   📄 Files:   ${projectData.files?.length ?? 0} files`);

// ── Step 2: Create files on disk ───────────────────────────────────────────
const createData = await api(
  {
    action: 'create',
    prompt: {
      projectName: projectData.projectName,
      files: projectData.files,
      description: 'Music store app like Boomplay',
    },
    originalPrompt: PROMPT,
  },
  'Step 2: Writing files to disk'
);

if (!createData.success) {
  console.error('❌ Create failed:', createData.error);
  process.exit(1);
}
const projectPath = createData.projectPath;
console.log(`   ✅ ${createData.filesCreated} files created at ${projectPath}`);

// ── Step 2.5: Pre-scan imports ─────────────────────────────────────────────
const scanData = await api(
  { action: 'pre-scan-imports', projectPath },
  'Step 2.5: Scanning imports'
);
if (scanData.addedPackages?.length > 0) {
  console.log(`   📋 Added packages: ${scanData.addedPackages.join(', ')}`);
}
if (scanData.nextAuthConfigured) {
  console.log('   🔐 next-auth auto-configured (NEXTAUTH_SECRET + auth route created)');
}

// ── Step 3: npm install ────────────────────────────────────────────────────
let installData = await api({ action: 'install', projectPath }, 'Step 3: npm install');
if (!installData.success) {
  console.log('   ⚠️  Retrying with --force…');
  installData = await api({ action: 'install', projectPath, flags: ['--force'] }, 'Step 3b: npm install --force');
}
if (!installData.success) {
  console.log('   ⚠️  Retrying without optional deps…');
  installData = await api({ action: 'install', projectPath, flags: ['--force', '--omit=optional'] }, 'Step 3c: npm install --force --omit=optional');
}
console.log(`   ${installData.success ? '✅ Installed' : '⚠️  Partial install — continuing'}`);

// ── Step 3.5: Post-install check ───────────────────────────────────────────
if (scanData.addedPackages?.length > 0) {
  const checkData = await api(
    { action: 'check-installed', projectPath, packages: scanData.addedPackages },
    'Step 3.5: Verifying packages landed'
  );
  if (checkData.missing?.length > 0) {
    console.log(`   ⚠️  Missing after install: ${checkData.missing.join(', ')} — retrying individually`);
    for (const pkg of checkData.missing) {
      const r = await api({ action: 'install-package', projectPath, packageName: pkg }, `  Installing ${pkg}`);
      console.log(`   ${r.success ? '✅' : '⚠️'} ${pkg}`);
    }
  } else {
    console.log('   ✅ All packages confirmed in node_modules');
  }
}

// ── Step 4: TypeScript validation + repair ─────────────────────────────────
console.log('\n⏳ Step 4: TypeScript validation…');
for (let round = 1; round <= 4; round++) {
  const valData = await api({ action: 'validate', projectPath }, `  Round ${round}`);
  if (valData.valid) {
    console.log('   ✅ TypeScript clean');
    break;
  }
  const errors = valData.errors ?? [];
  console.log(`   ⚠️  ${errors.length} error(s) — running auto-recover…`);
  if (errors.length > 0) {
    const recov = await api(
      { action: 'auto-recover', projectPath, errorText: errors.join('\n') },
      `  Auto-recover round ${round}`
    );
    console.log(`   → ${recov.successMessage ?? recov.kind ?? 'no fix available'}`);
    if (round === 3 && !valData.valid) {
      console.log('   ⚠️  Remaining errors — starting server anyway');
      break;
    }
  } else {
    break;
  }
}

// ── Step 5: Start server ───────────────────────────────────────────────────
const serverData = await api(
  { action: 'start-server', projectPath },
  'Step 5: Starting dev server'
);

if (!serverData.port) {
  // Strategy 2: clear cache + force restart
  console.log('   ⚠️  Strategy 2: clear cache + force restart…');
  await api({ action: 'clear-cache', projectPath }, '  Clearing .next cache');
  const serverData2 = await api(
    { action: 'start-server', projectPath, force: true },
    '  Force restart'
  );
  if (!serverData2.port) {
    console.error('❌ Server failed to start');
    process.exit(1);
  }
  serverData.port = serverData2.port;
}

const port = serverData.port;
console.log(`   ✅ Server running on port ${port}`);
console.log(`   🌐 Preview: http://localhost:${port}/`);

// ── Step 6: Wait for compilation ───────────────────────────────────────────
const readyData = await api(
  { action: 'wait-for-server', port, timeout: 90000 },
  'Step 6: Waiting for Next.js compilation'
);
if (readyData.ready) {
  console.log(`   ✅ App responding after ${(readyData.ms / 1000).toFixed(1)}s (HTTP ${readyData.statusCode})`);
} else {
  console.log('   ⏳ Still compiling — proceeding to verification');
}

// ── Step 7: Self-healing verification loop ────────────────────────────────
console.log('\n⏳ Step 7: Verification + self-healing…');
let verifyData = { verified: false, checks: [], summary: '' };
const MAX_ROUNDS = 5;
const triedCacheClear = false;
let currentPort = port;

for (let vround = 1; vround <= MAX_ROUNDS; vround++) {
  const vd = await api(
    { action: 'verify-app', port: currentPort, projectPath },
    `  Round ${vround}/${MAX_ROUNDS}`
  );
  verifyData = vd;

  for (const c of vd.checks ?? []) {
    const icon = c.passed ? '✅' : '❌';
    const detail = c.passed ? '' : ` — ${c.rootCause?.detail ?? c.error ?? ''}`;
    console.log(`   ${icon} ${c.name}${detail}`);
  }

  if (vd.verified) {
    console.log('\n🎉 App verified and running!');
    break;
  }
  if (vround >= MAX_ROUNDS) break;

  // Collect failures
  const failedChecks = (vd.checks ?? []).filter(c => !c.passed);
  const missingPkgs = failedChecks.flatMap(c => c.rootCause?.packages ?? []).filter((p, i, a) => a.indexOf(p) === i);
  const needsAuth = failedChecks.some(c => c.rootCause?.kind === 'auth-misconfigured');
  const hasCrash = failedChecks.some(c => ['runtime-crash', 'typescript-error', 'missing-package'].includes(c.rootCause?.kind));

  if (missingPkgs.length > 0) {
    console.log(`\n   📦 Installing missing: ${missingPkgs.join(', ')}`);
    const errTxt = missingPkgs.map(p => `Module not found: Can't resolve '${p}'`).join('\n');
    const recov = await api({ action: 'auto-recover', projectPath, errorText: errTxt }, '  auto-recover');
    if (recov.packagesInstalled?.length) console.log(`   ✅ Installed: ${recov.packagesInstalled.join(', ')}`);
    await api({ action: 'clear-cache', projectPath }, '  clear-cache');
    const rs = await api({ action: 'start-server', projectPath, force: true }, '  force-restart');
    if (rs.port) currentPort = rs.port;
    const rdy = await api({ action: 'wait-for-server', port: currentPort, timeout: 90000 }, '  wait-for-server');
    console.log(`   ${rdy.ready ? '✅' : '⏳'} Server ${rdy.ready ? `ready (${(rdy.ms/1000).toFixed(1)}s)` : 'still compiling'}`);
  } else if (needsAuth) {
    console.log('\n   🔐 Configuring auth…');
    await api({ action: 'auto-recover', projectPath, errorText: 'NEXTAUTH_SECRET is not set' }, '  auth-config');
    await api({ action: 'clear-cache', projectPath }, '  clear-cache');
    const rs = await api({ action: 'start-server', projectPath, force: true }, '  force-restart');
    if (rs.port) currentPort = rs.port;
    await api({ action: 'wait-for-server', port: currentPort, timeout: 60000 }, '  wait-for-server');
  } else if (hasCrash) {
    console.log('\n   🔄 Clean rebuild…');
    await api({ action: 'clear-cache', projectPath }, '  clear-cache');
    const rs = await api({ action: 'start-server', projectPath, force: true }, '  force-restart');
    if (rs.port) currentPort = rs.port;
    await api({ action: 'wait-for-server', port: currentPort, timeout: 90000 }, '  wait-for-server');
  } else {
    console.log('\n   ⏳ No specific fix — waiting for compilation to settle…');
    await api({ action: 'wait-for-server', port: currentPort, timeout: 30000 }, '  wait-for-server');
  }
}

// ── Final summary ─────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`Project:  ${genData.projectName}`);
console.log(`Path:     ${projectPath}`);
console.log(`Preview:  http://localhost:${currentPort}/`);
console.log(`Status:   ${verifyData.verified ? '✅ VERIFIED — app is running' : '⚠️  App started but not fully verified'}`);
console.log(`Summary:  ${verifyData.summary}`);
console.log('─'.repeat(60));
