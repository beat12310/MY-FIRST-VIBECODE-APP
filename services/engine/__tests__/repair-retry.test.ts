import { describe, it, expect } from 'vitest';
import { repair, type RepairerDeps } from '../repairer';
import type { AppPlan, ClassifiedFailure, VerifyResult } from '../types';

const minimalPlan: AppPlan = {
  projectName: 'test-app', displayName: 'Test App', description: 'A test app',
  intent: { appType: 'saas', secondaryTypes: [], confidence: 1, label: 'SaaS', source: 'keyword' },
  pages: [], apiRoutes: [], components: [], dataModels: [], requiresAuth: false,
  seo: { sitemap: false, robots: false, metadata: false, schema: false },
  uiStyle: { preset: 'modern', palette: [], animations: false },
  capabilities: [], resolvedCapabilities: [],
};

function failure(detail: string): ClassifiedFailure {
  return { origin: 'internal', area: 'structural', detail, repairable: true };
}

function verifyResultWith(failures: ClassifiedFailure[]): VerifyResult {
  return {
    passed: failures.length === 0,
    fileCount: 1, routes: [], apiRoutes: [], pagesGenerated: 1,
    deadLinks: [], notFoundRoutes: [], brokenImports: [], buildErrors: [],
    classifiedFailures: failures, externalIssues: [],
    workflowTests: [], securityChecks: [], performance: [],
  } as unknown as VerifyResult;
}

describe('repair() — bounded retry loop (fixed: unbounded Bedrock retries against an unfixable failure)', () => {
  it('stops at maxAttempts when a failure is never actually fixed, and reports it clearly (not silently)', async () => {
    // A DIFFERENT failure detail each iteration (real, but incomplete,
    // progress — the stall guard only fires on an IDENTICAL remaining set)
    // so this test genuinely exhausts maxAttempts rather than hitting the
    // stall guard first, as a single always-identical failure would.
    let applyFixCalls = 0;
    let verifyCalls = 0;
    const deps: RepairerDeps = {
      applyFix: async () => { applyFixCalls++; return { changedFiles: ['app/orders/page.tsx'] }; },
      verify: async () => { verifyCalls++; return verifyResultWith([failure(`Missing page variant #${verifyCalls}: app/orders/page.tsx`)]); },
      maxAttempts: 3,
    };

    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([failure('Missing page: app/orders/page.tsx')]), deps);

    expect(result.attempts).toBe(3);
    expect(result.resolved).toBe(false);
    expect(result.stopReason).toContain('maximum repair iterations');
    expect(result.remainingIssues.length).toBeGreaterThan(0);
    // Never silently gives up — the caller gets a clear, structured account
    // of what happened, not just a bare "false".
    expect(result.iterations).toHaveLength(3);
  });

  it('resolves and stops EARLY (not exhausting maxAttempts) when the failure is actually fixed on attempt 1', async () => {
    const theFailure = failure('Missing page: app/orders/page.tsx');
    let verifyCallCount = 0;
    const deps: RepairerDeps = {
      applyFix: async () => ({ changedFiles: ['app/orders/page.tsx'] }),
      verify: async () => {
        verifyCallCount++;
        return verifyResultWith([]); // resolved on the very first re-verify
      },
      maxAttempts: 5,
    };

    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([theFailure]), deps);

    expect(result.attempts).toBe(1);
    expect(result.resolved).toBe(true);
    // 'verification passed' fires (not 'all internal issues resolved') since
    // this fake verify's result also reports passed=true — the `current.passed`
    // check runs before the separate `remaining === 0` check.
    expect(result.stopReason).toBe('verification passed');
    expect(verifyCallCount).toBe(1);
  });

  it('escalates from a no-op batch fix to per-failure retry within the SAME iteration before giving up', async () => {
    const theFailure = failure('Missing page: app/orders/page.tsx');
    let perFailureApplyFixCalls = 0;
    const deps: RepairerDeps = {
      applyFix: async () => { perFailureApplyFixCalls++; return { changedFiles: ['app/orders/page.tsx'] }; },
      applyFixBatch: async () => ({ changedFiles: [] }), // batch produces nothing
      verify: async () => verifyResultWith([]), // resolved after the per-failure escalation applies the real fix
      maxAttempts: 5,
    };

    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([theFailure]), deps);

    expect(perFailureApplyFixCalls).toBeGreaterThan(0); // escalation path was actually exercised
    expect(result.resolved).toBe(true);
  });

  it('stops immediately (not burning all maxAttempts) when an iteration produces zero file changes', async () => {
    const theFailure = failure('Missing page: app/orders/page.tsx');
    let verifyCallCount = 0;
    const deps: RepairerDeps = {
      applyFix: async () => ({ changedFiles: [] }), // never actually changes anything
      verify: async () => { verifyCallCount++; return verifyResultWith([theFailure]); },
      maxAttempts: 5,
    };

    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([theFailure]), deps);

    expect(result.attempts).toBe(1); // did not burn all 5 attempts
    expect(result.stopReason).toContain('no code changes produced');
    expect(verifyCallCount).toBe(0); // never even re-verified — no point re-checking when nothing was written
  });

  it('the stall guard stops when the exact same failure set repeats across iterations with no progress', async () => {
    const theFailure = failure('Missing page: app/orders/page.tsx');
    const deps: RepairerDeps = {
      applyFix: async () => ({ changedFiles: ['app/orders/page.tsx'] }), // writes something every time...
      verify: async () => verifyResultWith([theFailure]), // ...but the SAME failure persists every time — no real progress
      maxAttempts: 5,
    };

    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([theFailure]), deps);

    // Stops for "no progress" well before exhausting all 5 attempts (stall
    // guard fires on the 2nd iteration, once the identical set repeats).
    expect(result.attempts).toBeLessThan(5);
    expect(result.stopReason).toContain('no progress');
  });

  it('skips calling applyFix/verify entirely when there are no actionable internal failures (zero Bedrock cost)', async () => {
    let applyFixCalled = false;
    const deps: RepairerDeps = {
      applyFix: async () => { applyFixCalled = true; return { changedFiles: [] }; },
      verify: async () => verifyResultWith([]),
    };
    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([]), deps);

    expect(applyFixCalled).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toContain('skipped');
  });

  it('respects a signal aborted before the first iteration starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const theFailure = failure('Missing page: app/orders/page.tsx');
    const deps: RepairerDeps = {
      applyFix: async () => ({ changedFiles: ['app/orders/page.tsx'] }),
      verify: async () => verifyResultWith([theFailure]),
      maxAttempts: 5,
    };
    const result = await repair(minimalPlan, '/tmp/test-project', verifyResultWith([theFailure]), deps, controller.signal);

    expect(result.attempts).toBe(0);
    expect(result.stopReason).toContain('cancelled');
  });
});
