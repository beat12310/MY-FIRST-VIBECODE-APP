/**
 * Standalone Bedrock health diagnostic — ZERO extra dependencies (no dotenv).
 *
 * Run from the project root:
 *   npx tsx scripts/bedrock-health.ts
 *
 * It loads .env.local itself (a standalone Node process does not do this
 * automatically — only Next.js does), then probes Bedrock with a tiny request and
 * prints a clear diagnostic. Never prints secret values.
 */
import { readFileSync } from 'fs';

// ── Load .env.local into process.env (no dotenv needed) ──────────────────────
try {
  const raw = readFileSync('.env.local', 'utf8');
  let loaded = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) { process.env[key] = val; loaded++; }
  }
  console.log(`[diag] .env.local loaded: ${loaded} variable(s)`);
} catch (e) {
  console.error('[diag] could NOT read .env.local:', e instanceof Error ? e.message : e);
  console.error('[diag] run this from the project root where .env.local lives.');
}

// ── Show what was detected (booleans only for secrets) ───────────────────────
console.log('[diag] AWS_REGION                 =', process.env.AWS_REGION ?? '(unset → defaults to us-east-1)');
console.log('[diag] AWS_ACCESS_KEY_ID present  =', !!process.env.AWS_ACCESS_KEY_ID);
console.log('[diag] AWS_SECRET_ACCESS_KEY pres =', !!process.env.AWS_SECRET_ACCESS_KEY);
console.log('[diag] BEDROCK_MODEL_SONNET       =', process.env.BEDROCK_MODEL_SONNET ?? '(unset → uses built-in default)');

// ── Probe Bedrock ────────────────────────────────────────────────────────────
(async () => {
  const { bedrockHealthCheck } = await import('@/services/bedrock-health');
  const result = await bedrockHealthCheck('SONNET');
  console.log('\n=== Bedrock health result ===');
  console.log(JSON.stringify(result, null, 2));
  if (result.ok) {
    console.log(`\n✅ Bedrock reachable — model '${result.modelId}' responded in ${result.latencyMs}ms.`);
  } else {
    console.log(`\n❌ Bedrock NOT usable — ${result.error}\n   Fix: ${result.recommendation}`);
  }
  process.exit(result.ok ? 0 : 1);
})();
