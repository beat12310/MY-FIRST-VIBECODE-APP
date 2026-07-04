import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });

const errors = [];
page.on('pageerror', e => errors.push(e.message));

const pass = (label) => console.log(`  PASS ${label}`);
const fail = (label, reason = '') => console.log(`  FAIL ${label}${reason ? ': ' + reason : ''}`);

async function findBtn(text) {
  const btns = await page.$$('button');
  for (const btn of btns) {
    const t = (await btn.innerText().catch(() => '')).toLowerCase();
    if (t.includes(text.toLowerCase())) return btn;
  }
  return null;
}

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 30000 });

// Wait for the projects list to populate from the API (async React state)
try {
  await page.waitForFunction(
    () => document.body.innerText.includes('ghana-property-premium-marketplace'),
    { timeout: 10000 }
  );
} catch { /* project may not be in viewport — proceed */ }
await page.waitForTimeout(500);

// ── 1. Open the marketplace project and wait for Live indicator ──────────────
console.log('\n[1] Opening project — waiting for ● Live indicator...');
const marketBtn = await findBtn('ghana-property-premium-marketplace');
if (!marketBtn) { console.log('  FAIL: project button not found'); await browser.close(); process.exit(1); }
await marketBtn.click();

// Wait until ● Live appears (means previewUrl is set and server is up)
try {
  await page.waitForFunction(
    () => document.body.innerText.includes('● Live'),
    { timeout: 30000 }
  );
  pass('● Live indicator appeared — project server running');
} catch {
  fail('● Live never appeared within 30s — taking screenshot for diagnosis');
  await page.screenshot({ path: 'public/browser-screenshots/test-fail-no-live.png' });
  await browser.close(); process.exit(1);
}
await page.screenshot({ path: 'public/browser-screenshots/test-1-live.png' });
console.log('  Screenshot: /browser-screenshots/test-1-live.png');

// ── 2. Screenshot button functional test ─────────────────────────────────────
console.log('\n[2] Screenshot button...');
const ssBtn = await findBtn('screenshot');
ssBtn ? pass('Screenshot button found in edit bar') : fail('Screenshot button missing');

if (ssBtn) {
  await ssBtn.click();
  // Wait for screenshot to complete and image to appear in chat
  try {
    await page.waitForFunction(
      () => !!document.querySelector('img[alt="Browser screenshot"]'),
      { timeout: 15000 }
    );
    pass('Screenshot image rendered in chat');
  } catch {
    fail('Screenshot image never appeared in chat');
  }
  await page.screenshot({ path: 'public/browser-screenshots/test-2-screenshot-result.png' });
}

// ── 3. Debug button functional test ──────────────────────────────────────────
console.log('\n[3] Debug button...');
const dbgBtn = await findBtn('debug');
dbgBtn ? pass('Debug button found in edit bar') : fail('Debug button missing');

if (dbgBtn) {
  await dbgBtn.click();
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('Root cause') && document.body.innerText.includes('browser debug'),
      { timeout: 20000 }
    );
    pass('Debug Rule-12 report appeared in chat');
  } catch {
    fail('Debug report not found in chat within 20s');
  }
  await page.screenshot({ path: 'public/browser-screenshots/test-3-debug-result.png' });
}

// ── 4. Files panel ───────────────────────────────────────────────────────────
console.log('\n[4] Files panel...');
const filesBtn = await findBtn('files');
if (filesBtn) {
  await filesBtn.click();
  await page.waitForTimeout(400);
  const newFileInput = await page.$('input[placeholder*="page.tsx"]');
  newFileInput ? pass('Files panel expanded — new-file input visible') : fail('new-file input not found');
  // Verify page/component file list items are present
  const deleteBtns = await page.$$('button[title="Delete"]');
  deleteBtns.length > 0 ? pass(`File list rendered (${deleteBtns.length} delete buttons)`) : fail('No file items in file list');
} else {
  fail('Files toggle button not found');
}

// ── 5. Memory panel ───────────────────────────────────────────────────────────
console.log('\n[5] Memory panel...');
const memBtn = await findBtn('memory');
if (memBtn) {
  await memBtn.click();
  await page.waitForTimeout(400);
  const clearBtn = await findBtn('clear memory');
  clearBtn ? pass('Memory panel expanded — Clear Memory button visible') : fail('Clear Memory button not found');
  // Verify some memory stat text is visible
  const memText = await page.$eval('div', () => document.body.innerText);
  const hasTurns = /\d+ conversation turns/.test(memText);
  const hasEdits = /\d+ edits/.test(memText);
  (hasTurns || hasEdits) ? pass('Memory stats visible') : fail('Memory stats text not found');
  await page.screenshot({ path: 'public/browser-screenshots/test-5-memory.png' });
} else {
  fail('Memory toggle button not found — currentMemory may be null');
}

// ── 6. DB panel options ───────────────────────────────────────────────────────
console.log('\n[6] Database panel...');
for (const v of ['supabase','postgresql','dynamodb','firebase']) {
  const opt = await page.$(`option[value="${v}"]`);
  opt ? pass(`${v} option`) : fail(`${v} option missing`);
}

// ── 7. Deploy panel options ───────────────────────────────────────────────────
console.log('\n[7] Deploy panel...');
for (const v of ['vercel','netlify','amplify']) {
  const opt = await page.$(`option[value="${v}"]`);
  opt ? pass(`${v} option`) : fail(`${v} option missing`);
}

// ── 8. Auth panel + hint text ─────────────────────────────────────────────────
console.log('\n[8] Auth panel...');
for (const v of ['nextauth','supabase','clerk','jwt']) {
  const opt = await page.$(`option[value="${v}"]`);
  opt ? pass(`${v} auth option`) : fail(`${v} auth option missing`);
}
// Test hint text by selecting Clerk — find the auth select (has jwt option)
const selects = await page.$$('select');
let authSelect = null;
for (const sel of selects) {
  const hasJwt = await sel.$('option[value="jwt"]').catch(() => null);
  if (hasJwt) { authSelect = sel; break; }
}
if (authSelect) {
  await authSelect.selectOption('clerk');
  await page.waitForTimeout(300);
  const clerkHint = await page.$$eval('div', divs =>
    divs.map(d => d.innerText).find(t => t.includes('Clerk account') || t.includes('Managed auth')) ?? ''
  );
  clerkHint ? pass('Auth hint text updates when Clerk selected') : fail('Clerk hint text not found');
  await authSelect.selectOption('nextauth');
} else {
  fail('Auth select not found');
}

// ── 9. Verification badge in sidebar footer ───────────────────────────────────
console.log('\n[9] Verification badge...');
const bodyText = await page.evaluate(() => document.body.innerText);
const hasVerified = bodyText.includes('Verified') || bodyText.includes('Verification');
hasVerified ? pass('Verification badge present in sidebar footer') : fail('Verification badge not found');

console.log('\nRUNTIME ERRORS:', errors.length === 0 ? 'NONE' : errors.map(e => e.slice(0, 200)));
await browser.close();
