/**
 * DWOMOH Vibe Code — Level 2: Scheduled Real AI Verification.
 *
 * Runs a handful of representative real user prompts through the REAL
 * engine (real Bedrock calls, real builds) and compares the result against
 * the last known-good run for each prompt, reporting any regression in
 * prompt understanding, planning, or repair quality automatically.
 *
 * Deliberately NOT run on every commit — real Bedrock cost + latency +
 * non-determinism make it unsuitable for the fast, every-commit gate (see
 * services/engine/__tests__/e2e-pipeline.test.ts for that deterministic
 * counterpart). Intended to run on a schedule (see
 * .github/workflows/scheduled-verification.yml) or via manual trigger.
 *
 * Run: npx tsx scripts/real-ai-verification.ts
 * Requires real AWS/Bedrock credentials configured in the environment —
 * this actually calls the model and incurs real cost.
 */
import { join } from 'path';
import { runRealBuild, findRegressions, loadBaseline, saveBaseline, type RealRunSummary } from './real-build-runner';

// A small, deliberately varied set — not the full Golden Project Suite
// (scripts/golden-project-suite.ts), which is scoped to 8 specific
// real-world app types that must survive every release. This set is about
// catching general prompt-understanding/planning/repair drift.
const REPRESENTATIVE_PROMPTS = [
  'Build a football prediction app where users can predict match results and see who has the most correct predictions on a leaderboard',
  'I want a website where people can book appointments with local hairdressers, with a calendar and reminders',
  'Create a simple expense tracker with categories, monthly totals, and a chart',
];

const BASELINE_PATH = join(process.cwd(), 'scripts/.baselines/real-ai-verification.json');

async function main() {
  const baseline = await loadBaseline(BASELINE_PATH);
  const current: RealRunSummary[] = [];

  for (const prompt of REPRESENTATIVE_PROMPTS) {
    console.log(`\n▶ Running: "${prompt}"`);
    const result = await runRealBuild(prompt);
    current.push(result);
    console.log(`  ${result.success ? '✓' : '✗'} success=${result.success} verify=${result.verifyStatus} repair=${result.repairStatus} preview=${result.previewStatus} (${result.durationMs}ms)`);
  }

  const regressions = findRegressions(baseline, current);
  if (regressions.length > 0) {
    console.error(`\n✗ ${regressions.length} regression(s) found compared to the last known-good run:\n`);
    for (const r of regressions) {
      console.error(`  "${r.prompt}" — ${r.field}: ${JSON.stringify(r.previous)} → ${JSON.stringify(r.current)}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n✓ No regressions compared to the last known-good run.');
  }

  // Only ever advances the baseline for a prompt that itself succeeded —
  // never lets a failing run silently become the new "known good" bar.
  const nextBaseline = current.map(cur => cur.success ? cur : (baseline.find(b => b.prompt === cur.prompt) ?? cur));
  await saveBaseline(BASELINE_PATH, nextBaseline);
}

if (require.main === module) {
  main().catch(e => { console.error('real-ai-verification failed:', e); process.exit(1); });
}
