/**
 * DWOMOH Vibe Code — real-AI build runner, shared by Level 2 (scheduled real
 * Bedrock verification, scripts/real-ai-verification.ts) and Level 3 (the
 * Golden Project Suite, scripts/golden-project-suite.ts).
 *
 * Deliberately NOT run as part of `npm run verify`/pre-commit/the per-commit
 * CI workflow — every call here does a REAL Bedrock build (cost + latency +
 * non-determinism), which is the opposite of what the fast, every-commit
 * gate needs. This is the "real AI" counterpart to the deterministic fixture
 * in services/engine/__tests__/e2e-pipeline.test.ts, meant to run on a
 * schedule or by explicit manual trigger only.
 */
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPipeline, defaultOrchestratorDeps } from '../services/engine/orchestrator';

export interface RealRunSummary {
  prompt: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  buildStatus: string;
  verifyStatus: string;
  repairStatus: string;
  previewStatus: string;
  fileCount: number;
  routeCount: number;
  remainingInternalIssues: number;
  summary: string;
}

// Duplicated from services/engine-adapter.ts (not exported from
// orchestrator.ts) rather than importing that module, which pulls in
// billing/credit-wallet side effects this standalone script has no use for.
async function readProjectFiles(projectPath: string): Promise<{ path: string; content: string }[]> {
  const SKIP = new Set(['node_modules', '.next', '.git', '.dwomoh']);
  const out: { path: string; content: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      let s; try { s = await stat(p); } catch { continue; }
      if (s.isDirectory()) await walk(p);
      else if (/\.(tsx?|jsx?|css|json)$/.test(e)) {
        try { out.push({ path: p.replace(projectPath + '/', ''), content: await readFile(p, 'utf8') }); } catch { /* skip unreadable */ }
      }
    }
  };
  await walk(projectPath);
  return out;
}

/** Runs ONE real, live build+repair+verify+preview cycle for a prompt. Real Bedrock cost. */
export async function runRealBuild(prompt: string, cleanupAfter = true): Promise<RealRunSummary> {
  const start = Date.now();
  const deps = await defaultOrchestratorDeps(readProjectFiles);
  const result = await runPipeline(prompt, deps);

  const summary: RealRunSummary = {
    prompt,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    success: result.success,
    buildStatus: result.buildStatus,
    verifyStatus: result.verifyStatus,
    repairStatus: result.repairStatus,
    previewStatus: result.previewStatus,
    fileCount: result.build?.filesCreated.length ?? 0,
    routeCount: result.verify?.routes.length ?? 0,
    remainingInternalIssues: result.repair?.remainingIssues.length ?? 0,
    summary: result.summary,
  };

  if (cleanupAfter && result.build?.projectPath) {
    await rm(result.build.projectPath, { recursive: true, force: true }).catch(() => {});
  }
  return summary;
}

export interface RegressionFinding {
  prompt: string;
  field: keyof RealRunSummary;
  previous: unknown;
  current: unknown;
}

/**
 * Compares a fresh run against its last recorded baseline for the SAME
 * prompt. Flags a regression when a previously-successful run (baseline.
 * success === true) is no longer successful, or when a status field that
 * was previously good has gotten worse — NOT on every superficial diff
 * (e.g. fileCount/durationMs naturally vary run to run and are not treated
 * as regressions on their own).
 */
export function findRegressions(baseline: RealRunSummary[], current: RealRunSummary[]): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  const byPrompt = new Map(baseline.map(b => [b.prompt, b]));
  for (const cur of current) {
    const prev = byPrompt.get(cur.prompt);
    if (!prev) continue; // no baseline yet for this prompt — nothing to compare against
    if (prev.success && !cur.success) findings.push({ prompt: cur.prompt, field: 'success', previous: prev.success, current: cur.success });
    if (prev.verifyStatus === 'passed' && cur.verifyStatus !== 'passed') findings.push({ prompt: cur.prompt, field: 'verifyStatus', previous: prev.verifyStatus, current: cur.verifyStatus });
    if (prev.previewStatus === 'available' && cur.previewStatus !== 'available') findings.push({ prompt: cur.prompt, field: 'previewStatus', previous: prev.previewStatus, current: cur.previewStatus });
    if (prev.remainingInternalIssues === 0 && cur.remainingInternalIssues > 0) findings.push({ prompt: cur.prompt, field: 'remainingInternalIssues', previous: prev.remainingInternalIssues, current: cur.remainingInternalIssues });
  }
  return findings;
}

export async function loadBaseline(path: string): Promise<RealRunSummary[]> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return []; }
}

export async function saveBaseline(path: string, runs: RealRunSummary[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(runs, null, 2), 'utf8');
}

/** For scripts that want an isolated scratch root instead of the shared generated-projects/ dir. */
export function scratchRoot(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}`);
}
