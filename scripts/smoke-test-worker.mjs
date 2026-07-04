#!/usr/bin/env node
/**
 * End-to-end build-worker smoke test.
 * Exercises the real path that fails on Amplify — write files → npm install →
 * start dev server → fetch a PUBLIC https preview URL — directly against the worker.
 * No Bedrock needed: it ships a tiny fixed project so the test is deterministic.
 *
 * Usage:
 *   WORKER_URL=https://worker.dwomohvibe.com \
 *   WORKER_SECRET=xxxx \
 *   PREVIEW_URL=https://preview.dwomohvibe.com \
 *   node scripts/smoke-test-worker.mjs
 */
const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const PREVIEW_URL = process.env.PREVIEW_URL;
if (!WORKER_URL || !WORKER_SECRET || !PREVIEW_URL) {
  console.error('Set WORKER_URL, WORKER_SECRET, and PREVIEW_URL'); process.exit(2);
}

const MARKER = `SMOKE_OK_${Date.now()}`;
const api = async (body) => {
  const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};

const projectData = {
  projectName: 'smoke-test-app',
  description: 'worker smoke test',
  files: [
    { path: 'package.json', content: JSON.stringify({
      name: 'smoke-test-app', version: '0.1.0', private: true,
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: '14.2.10', react: '^18', 'react-dom': '^18' },
    }, null, 2) },
    { path: 'next.config.js', content: 'module.exports = {};\n' },
    { path: 'app/layout.tsx', content:
      `export default function R({children}:{children:React.ReactNode}){return(<html><body>{children}</body></html>);}\n` },
    { path: 'app/page.tsx', content:
      `export default function P(){return(<main><h1>${MARKER}</h1></main>);}\n` },
  ],
};

function step(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

(async () => {
  console.log(`▶ Worker: ${WORKER_URL}\n▶ Preview: ${PREVIEW_URL}\n`);

  const health = await fetch(`${WORKER_URL}/__health`).then(r => r.status).catch(() => 0);
  if (!step('Worker health', health === 200, `HTTP ${health}`)) return;

  const create = await api({ action: 'create', prompt: projectData });
  if (!step('create (write files)', create.json.success === true, create.json.error || `${create.json.filesCreated} files`)) return;
  const projectPath = create.json.projectPath;

  const install = await api({ action: 'install', projectPath });
  step('install (npm)', install.json.success === true, install.json.error || 'deps installed');

  const start = await api({ action: 'start-server', projectPath, force: true });
  if (!step('start-server', !!start.json.port, `port=${start.json.port} previewUrl=${start.json.previewUrl}`)) return;

  // give Next.js a moment to compile, then hit the PUBLIC preview URL
  await new Promise(r => setTimeout(r, 15000));
  let html = '', code = 0;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(PREVIEW_URL + '/', { headers: { Accept: 'text/html' } });
      code = res.status; html = await res.text();
      if (code === 200 && html.includes(MARKER)) break;
    } catch (e) { code = 0; }
    await new Promise(r => setTimeout(r, 5000));
  }
  step('public preview serves the app', code === 200 && html.includes(MARKER), `HTTP ${code}, marker ${html.includes(MARKER) ? 'found' : 'missing'}`);

  console.log(process.exitCode ? '\n❌ Smoke test FAILED' : '\n✅ Smoke test PASSED — live generation path works end-to-end');
})();
