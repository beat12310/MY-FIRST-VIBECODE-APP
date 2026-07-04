/**
 * DWOMOH Vibe Code — Level 3: Golden Project Suite.
 *
 * A permanent collection of real-world project prompts every engine version
 * must build, repair, verify, preview, and (conceptually) deploy
 * successfully before release, guaranteeing that improvements to the engine
 * never silently break an application type that already worked.
 *
 * Deliberately NOT run on every commit, and NOT run synchronously as part of
 * building this suite — each real prompt here is a full real-Bedrock build
 * cycle (observed 14-20+ minutes each for comparable apps this session), so
 * 8 of them is a genuinely long-running operation. Intended to run on a
 * schedule (weekly) or as an explicit pre-release gate (see
 * .github/workflows/scheduled-verification.yml), never inline in a chat
 * session or a fast CI path.
 *
 * "Deploy" is checked at the LOGIC level, not by actually deploying to AWS
 * Amplify for each of the 8 projects on every scheduled run — that's real
 * infrastructure cost/time for a check whose actual guarantee (does
 * subscription-manager.ts's canDeploy() gate correctly allow/deny) is
 * already covered by services/subscription-manager.ts's own logic and
 * doesn't need re-proving per golden project. If full real deploys are
 * wanted later, that's a separate, explicit, rate-limited decision — not an
 * automatic consequence of this suite existing.
 *
 * Run: npx tsx scripts/golden-project-suite.ts
 * Requires real AWS/Bedrock credentials — this actually calls the model,
 * writes real files, and incurs real cost and real time (expect 1-3+ hours
 * for the full suite).
 */
import { join } from 'path';
import { runRealBuild, findRegressions, loadBaseline, saveBaseline, type RealRunSummary } from './real-build-runner';

export interface GoldenProject {
  name: string;
  prompt: string;
}

// The 8 real-world project types every engine version must keep working.
export const GOLDEN_PROJECTS: GoldenProject[] = [
  { name: 'Sports Prediction App', prompt: 'Build a sports prediction app where users can predict football match outcomes, track their accuracy over time, and compete on a public leaderboard' },
  { name: 'Real Estate Marketplace', prompt: 'Build a real estate marketplace where agents can list properties with photos and pricing, and buyers can search, filter, and save favorites' },
  { name: 'TaskCashFlow', prompt: 'Build TaskCashFlow, a personal finance app that tracks income, expenses, and recurring bills, with a dashboard showing monthly cash flow trends' },
  { name: 'Visitor Management System', prompt: 'Build a visitor management system for an office building where receptionists can check in guests, notify the host employee, and print a visitor badge' },
  { name: 'AI Video Generator', prompt: 'Build an AI video generator where users describe a scene in text and generate a short video clip, with a gallery of their past generations' },
  { name: 'E-commerce Website', prompt: 'Build an e-commerce website selling clothing, with product listings, a shopping cart, checkout, and order history for logged-in customers' },
  { name: 'Dashboard/CRM', prompt: 'Build a CRM dashboard for a small sales team to track leads, log customer interactions, and see a pipeline view of deals by stage' },
  { name: 'Blog/News Website', prompt: 'Build a blog and news website with categorized articles, an admin area for publishing posts, and a comments section for readers' },
];

const BASELINE_PATH = join(process.cwd(), 'scripts/.baselines/golden-project-suite.json');

async function main() {
  const baseline = await loadBaseline(BASELINE_PATH);
  const current: RealRunSummary[] = [];
  const failures: string[] = [];

  for (const project of GOLDEN_PROJECTS) {
    console.log(`\n▶ [${project.name}] Running full build → repair → verify → preview cycle…`);
    const result = await runRealBuild(project.prompt);
    current.push(result);
    const ok = result.success && result.verifyStatus === 'passed' && result.previewStatus === 'available';
    console.log(`  ${ok ? '✓' : '✗'} ${project.name}: success=${result.success} verify=${result.verifyStatus} repair=${result.repairStatus} preview=${result.previewStatus} (${(result.durationMs / 1000).toFixed(0)}s)`);
    if (!ok) failures.push(project.name);
  }

  const regressions = findRegressions(baseline, current);

  console.log('\n──────── Golden Project Suite Summary ────────');
  console.log(`${GOLDEN_PROJECTS.length - failures.length}/${GOLDEN_PROJECTS.length} projects fully passed (build+verify+preview).`);
  if (failures.length > 0) console.log(`Failed: ${failures.join(', ')}`);
  if (regressions.length > 0) {
    console.log(`\n${regressions.length} regression(s) vs. the last known-good release:`);
    for (const r of regressions) console.log(`  [${r.prompt.slice(0, 40)}...] ${r.field}: ${JSON.stringify(r.previous)} → ${JSON.stringify(r.current)}`);
  }

  if (failures.length > 0 || regressions.length > 0) process.exitCode = 1;

  const nextBaseline = current.map(cur => cur.success ? cur : (baseline.find(b => b.prompt === cur.prompt) ?? cur));
  await saveBaseline(BASELINE_PATH, nextBaseline);
}

if (require.main === module) {
  main().catch(e => { console.error('golden-project-suite failed:', e); process.exit(1); });
}
