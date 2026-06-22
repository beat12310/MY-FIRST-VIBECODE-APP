/**
 * End-to-end model routing test.
 * Imports the real services directly — no HTTP layer, no mocking.
 * Run: npx tsx test-model-routing.ts
 */

// .env.local is loaded by the shell before this script runs (see test command)
import { BEDROCK_MODELS, BEDROCK_FALLBACK_CHAINS } from './lib/constants';
import { buildWithAI, fixErrorsWithAI, converseWithEngineer } from './services/bedrock';

// ── Intercept console to capture [Bedrock] log lines ─────────────────────────
const capturedLogs: string[] = [];
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);

console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  capturedLogs.push(line);
  origLog(...args);
};
console.warn = (...args: unknown[]) => {
  const line = '[WARN] ' + args.map(String).join(' ');
  capturedLogs.push(line);
  origWarn(...args);
};
console.error = () => {}; // suppress noise

function modelLines() {
  return capturedLogs.filter(l => l.includes('[Bedrock]') || l.includes('WARN'));
}

function sep(t: string) {
  origLog('\n' + '═'.repeat(64));
  origLog(`  ${t}`);
  origLog('═'.repeat(64));
}

async function main() {
  // ── STEP 0 — show resolved IDs ──────────────────────────────────────────
  sep('STEP 0 — Model IDs resolved from .env.local → lib/constants.ts');
  origLog(`  env BEDROCK_MODEL_HAIKU     = ${process.env.BEDROCK_MODEL_HAIKU ?? '(unset)'}`);
  origLog(`  env BEDROCK_MODEL_SONNET    = ${process.env.BEDROCK_MODEL_SONNET ?? '(unset)'}`);
  origLog(`  env BEDROCK_MODEL_STRONGEST = ${process.env.BEDROCK_MODEL_STRONGEST ?? '(unset)'}`);
  origLog(`  env BEDROCK_MODEL_OPUS      = ${process.env.BEDROCK_MODEL_OPUS ?? '(unset)'}`);
  origLog('');
  origLog(`  BEDROCK_MODELS.HAIKU        → ${BEDROCK_MODELS.HAIKU}`);
  origLog(`  BEDROCK_MODELS.SONNET       → ${BEDROCK_MODELS.SONNET}`);
  origLog(`  BEDROCK_MODELS.STRONGEST    → ${BEDROCK_MODELS.STRONGEST}`);
  origLog('');
  origLog('  Fallback chains (tried in order if primary unavailable):');
  for (const [tier, chain] of Object.entries(BEDROCK_FALLBACK_CHAINS)) {
    origLog(`    ${tier.padEnd(10)} ${chain.join('\n              → ')}`);
  }

  // ── TEST 1: Chat — HAIKU ─────────────────────────────────────────────────
  sep('TEST 1 — converseWithEngineer  [tier: HAIKU → simple chat]');
  capturedLogs.length = 0;
  const t1 = Date.now();
  const chatReply = await converseWithEngineer(
    [{ role: 'user', content: 'In one sentence, what is Tailwind CSS?' }],
    'You are a helpful coding assistant.',
    'HAIKU',
  );
  const ms1 = Date.now() - t1;
  origLog(`  Reply:   ${chatReply.trim().slice(0, 150)}`);
  origLog(`  Time:    ${ms1}ms`);
  origLog('  [Bedrock] log lines from this call:');
  for (const l of modelLines()) origLog(`    ${l}`);

  // ── TEST 2: App generation — SONNET ─────────────────────────────────────
  sep('TEST 2 — buildWithAI  [tier: SONNET → app generation]');
  capturedLogs.length = 0;
  const t2 = Date.now();
  const genReply = await buildWithAI(
    `Build a personal budget tracker app with Next.js and Tailwind.
Include: add income/expense entries, category labels, running balance display.

Output a complete project using this exact format:

[START_PROJECT]
name: budget-tracker
description: Personal budget tracker

[FILE: app/page.tsx]
<full file content here>
[END_FILE]

[FILE: app/layout.tsx]
<full file content here>
[END_FILE]

[FILE: package.json]
<full content>
[END_FILE]
[END_PROJECT]`,
    'You are a senior Next.js engineer. Return a real multi-file Next.js 15 project in [START_PROJECT] format. No placeholders.',
    'SONNET',
  );
  const ms2 = Date.now() - t2;
  const fileMatches = [...genReply.matchAll(/\[FILE:\s*([^\]]+)\]/g)];
  const hasStartProject = genReply.includes('[START_PROJECT]');
  origLog(`  Response length:    ${genReply.length} chars`);
  origLog(`  Has [START_PROJECT]: ${hasStartProject}`);
  origLog(`  Files in response:  ${fileMatches.length}`);
  for (const m of fileMatches.slice(0, 15)) origLog(`    → ${m[1].trim()}`);
  origLog(`  Time:    ${ms2}ms`);
  origLog('  [Bedrock] log lines from this call:');
  for (const l of modelLines()) origLog(`    ${l}`);

  // ── TEST 3: Error repair — STRONGEST ────────────────────────────────────
  sep('TEST 3 — fixErrorsWithAI  [tier: STRONGEST → advanced repair]');
  capturedLogs.length = 0;
  const t3 = Date.now();
  const repairReply = await fixErrorsWithAI(
    `Fix this broken TypeScript React component:

\`\`\`tsx
// BudgetForm.tsx — BROKEN
export default function BudgetForm() {
  const [amount, setAmount] = useState('');          // Error: useState not imported
  const [category, setCategory] = useState('food');  // Error: useState not imported

  const handleSubmit = (e) => {                      // Error: implicit any on 'e'
    e.preventDefault();
    console.log(amount, category);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={amount} onChange={e => setAmount(e.target.value)} />
      <select value={category} onChange={e => setCategory(e.target.value)}>
        <option value="food">Food</option>
        <option value="rent">Rent</option>
      </select>
      <button type="submit">Add</button>
    </form>
  );
}
\`\`\`

Errors:
1. Cannot find name 'useState' (missing import)
2. Parameter 'e' implicitly has an 'any' type

Return ONLY the fixed file inside a [FILE: components/BudgetForm.tsx] block.`,
    'You are an expert TypeScript/React debugger. Fix all errors. Return only code.',
    'STRONGEST',
  );
  const ms3 = Date.now() - t3;
  const fixedImport = repairReply.includes("import") && repairReply.includes("useState");
  const fixedEvent  = repairReply.includes("React.FormEvent") || repairReply.includes("FormEvent") || repairReply.includes(": React.");
  origLog(`  Response length:          ${repairReply.length} chars`);
  origLog(`  Fixed useState import:    ${fixedImport ? 'YES ✅' : 'NO ❌'}`);
  origLog(`  Fixed event type:         ${fixedEvent  ? 'YES ✅' : 'NO ❌'}`);
  origLog(`  Time:    ${ms3}ms`);
  origLog('  [Bedrock] log lines from this call:');
  for (const l of modelLines()) origLog(`    ${l}`);
  origLog('');
  origLog('  Fixed code (first 400 chars):');
  origLog('  ' + repairReply.trim().slice(0, 400));

  // ── FINAL SUMMARY ───────────────────────────────────────────────────────
  sep('FINAL SUMMARY');
  const p1 = chatReply.length > 10;
  const p2 = fileMatches.length >= 2 && hasStartProject;
  const p3 = fixedImport;
  origLog(`  TEST 1 HAIKU    / chat:        ${p1 ? '✅ PASS' : '❌ FAIL'}  (${ms1}ms)`);
  origLog(`  TEST 2 SONNET   / generation:  ${p2 ? '✅ PASS' : '❌ FAIL'}  (${ms2}ms)`);
  origLog(`  TEST 3 STRONGEST/ repair:      ${p3 ? '✅ PASS' : '❌ FAIL'}  (${ms3}ms)`);
  origLog('');
  origLog('  Model actually called for each test (from [Bedrock] lines):');
  origLog('  (shown in per-test sections above — look for "model=..." lines)');
  origLog('');
  process.exit(p1 && p2 && p3 ? 0 : 1);
}

main().catch(e => {
  origLog('FATAL:', e);
  process.exit(1);
});
