import { describe, it, expect } from 'vitest';
import { runPipeline, StageTimeoutError, computeRepairTimeout, type OrchestratorDeps } from '../orchestrator';
import type { AppPlan, BuildResult, VerifyResult, RepairResult } from '../types';

const minimalPlan: AppPlan = {
  projectName: 'test-app', displayName: 'Test App', description: 'A test app',
  intent: { appType: 'saas', secondaryTypes: [], confidence: 1, label: 'SaaS', source: 'keyword' },
  pages: [], apiRoutes: [], components: [], dataModels: [], requiresAuth: false,
  seo: { sitemap: false, robots: false, metadata: false, schema: false },
  uiStyle: { preset: 'modern', palette: [], animations: false },
  capabilities: [], resolvedCapabilities: [],
};

const minimalBuild: BuildResult = {
  projectPath: '/tmp/test-project', isFreshFolder: true,
  filesCreated: [{ path: 'app/page.tsx', bytes: 100 }], foldersCreated: 1,
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  recoveredFromLooseFormat: false, logs: [],
};

const minimalRepair: RepairResult = {
  attempts: 0, maxAttempts: 5, changedFiles: [], resolved: true,
  remainingIssues: [], skippedExternalIssues: [],
};

/**
 * Base deps every test in this file starts from — only `verify` is
 * overridden per-test, and `timeouts` is always tiny so a genuinely hung
 * stage is proven to be cut off in milliseconds during the test run, not
 * the real 120-second production budget (services/engine/orchestrator.ts's
 * DEFAULT_STAGE_TIMEOUTS.verify).
 */
function baseDeps(overrides: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    plan: () => minimalPlan,
    needsClarification: () => false,
    clarificationQuestion: () => 'What kind of app?',
    build: async () => minimalBuild,
    verify: async (): Promise<VerifyResult> => ({
      passed: true, fileCount: 1, routes: [], apiRoutes: [], pagesGenerated: 1,
      classifiedFailures: [], externalIssues: [], workflowTests: [], securityChecks: [],
      performance: [], deadLinks: [], brokenImports: [], missingExports: [], placeholders: [],
      missingPlanned: [], buildErrors: [],
    } as unknown as VerifyResult),
    repair: async (): Promise<RepairResult> => minimalRepair,
    learn: async () => undefined,
    timeouts: { plan: 500, build: 500, verify: 100, repair: 500, learn: 500, preview: 500 },
    ...overrides,
  };
}

describe('orchestrator — verification never hangs (fixed via withTimeout, DEFAULT_STAGE_TIMEOUTS.verify)', () => {
  // ROOT CAUSE this guards against: without withTimeout's AbortController
  // race, a verify stage stuck waiting on a probe/HTTP call that never
  // resolves would hang the entire pipeline indefinitely — the user's
  // reported "verification got stuck for over 20 minutes and did not
  // complete properly." withTimeout races the stage against a per-stage
  // timeout (2 minutes in production for 'verify') and force-aborts it.
  it('a verify stage that never resolves on its own does not hang the pipeline — it times out and the pipeline still completes', async () => {
    let sawAbort = false;
    const deps = baseDeps({
      verify: (_plan, _path, _previewUrl, signal) => new Promise((_resolve, _reject) => {
        // Deliberately NEVER resolves/rejects on its own — simulates a
        // genuinely hung verification (e.g. a probe stuck on a dead server).
        signal?.addEventListener('abort', () => { sawAbort = true; });
      }),
    });

    const start = Date.now();
    // Race against a generous sentinel so a REGRESSION (the pipeline
    // actually hanging) fails this test loudly instead of hanging the whole
    // suite forever.
    const result = await Promise.race([
      runPipeline('build a test app', deps),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TEST SENTINEL: runPipeline did not settle within 5s — verification is hanging')), 5000)),
    ]);
    const elapsedMs = Date.now() - start;

    // Must complete close to the configured 100ms verify timeout, not the
    // 5-second sentinel — proves the real timeout mechanism fired, not the
    // test's own safety net.
    expect(elapsedMs).toBeLessThan(2000);
    expect(sawAbort).toBe(true);
    // The pipeline continues past a timed-out verify (verify becomes null,
    // logged, and the run proceeds to repair/preview/etc.) rather than
    // throwing/crashing — confirms the "recover and continue" behavior.
    expect(result.verifyStatus).toBe('not_run');
    expect(result.logs.some(l => l.includes('VERIFY') && l.includes('did not complete'))).toBe(true);
  });

  it('a verify stage that resolves quickly is NOT falsely reported as timed out', async () => {
    const deps = baseDeps({}); // uses the default fast-resolving verify stub
    const result = await runPipeline('build a test app', deps);
    expect(result.verifyStatus).toBe('passed');
  });

  it('StageTimeoutError carries the stage name and configured timeout for diagnostics', () => {
    const err = new StageTimeoutError('verify', 120_000);
    expect(err.stage).toBe('verify');
    expect(err.ms).toBe(120_000);
    expect(err.message).toContain('verify');
    expect(err.message).toContain('120000');
  });
});

describe('computeRepairTimeout — adaptive budget calibrated against real multi-iteration repair costs', () => {
  // Confirmed live via the Golden Project Suite's repair-engine validation
  // run: even AFTER repairer.ts's applyFixBatch started running its chunked
  // Bedrock calls concurrently (cutting a single iteration's cost
  // dramatically), the timeout formula was still only budgeting for roughly
  // ONE iteration -- a real repair typically needs 2-4 to converge. Two
  // concrete near-misses in the same run: a 15-failure build missed a 280s
  // budget by 7 seconds after 4 iterations; a 27-failure build's first
  // iteration alone (already parallelized) took ~198s against a 376s total
  // budget, leaving only ~178s for a second iteration.
  it('small batches (<=10 failures) keep the exact base timeout, unchanged', () => {
    expect(computeRepairTimeout(5, 240_000)).toBe(240_000);
    expect(computeRepairTimeout(10, 240_000)).toBe(240_000);
  });

  it('a 15-failure batch gets enough budget to have covered the real 287s near-miss', () => {
    const timeout = computeRepairTimeout(15, 240_000);
    expect(timeout).toBeGreaterThan(287_000);
  });

  it('a 27-failure batch gets enough budget for a slow ~198s first iteration plus a real second iteration', () => {
    const timeout = computeRepairTimeout(27, 240_000);
    expect(timeout).toBeGreaterThan(198_000 + 178_000); // first iteration's real cost + more than it got last time for the rest
  });

  it('still caps at REPAIR_MAX_TIMEOUT_MS for very large failure counts', () => {
    expect(computeRepairTimeout(500, 240_000, 600_000)).toBe(600_000);
  });
});
