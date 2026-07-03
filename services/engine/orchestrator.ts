/**
 * DWOMOH VIBE CODE — Orchestrator (Step 7).
 *
 * Coordinates the full pipeline:
 *   Plan → Build → Verify(static) → (Repair if internal failures) → Verify(static)
 *        → Preview → Verify(runtime, against the live preview) → Learn → Report
 *
 * Rules enforced here:
 *   - Every engine is INJECTED (no hard engine imports) → fully testable, standalone.
 *   - status === 'complete' ONLY when the final VerifyResult.passed is true on a
 *     FRESH build with real files (the Success Rule).
 *   - Repair runs at most once (the Repairer is itself a bounded ≤5-attempt loop)
 *     and is invoked ONLY when internal, repairable failures exist. External
 *     provider failures are never repaired.
 *   - The Learner runs ONLY after a verified-successful build.
 *   - Verify runs THREE times, not two: twice statically (pre- and post-repair,
 *     no live server exists yet) and ONCE more against the actual running
 *     preview once it starts — this is what lets VerifyResult.passed become
 *     true at all (previewLoads can only be measured against a real server;
 *     static analysis alone can never confirm the app actually loads). The
 *     runtime pass is purely ADDITIVE: if preview never started, or the runtime
 *     pass itself errors/times out, the pipeline keeps the static-only verify
 *     result — this can only make `passed` more accurate, never hide preview.
 *   - Returns facts only (EngineReport) plus complete execution logs. Never connects
 *     to localhost and is not wired into /api/chat.
 */
import type {
  AppPlan, BuildResult, ClassifiedFailure, EngineReport, EngineStatus,
  RepairResult, VerifyResult,
} from './types';

export interface OrchestratorResult extends EngineReport {
  /** Complete, ordered execution log of the run (orchestrator-level). */
  logs: string[];
}

export interface LearnInput {
  plan: AppPlan;
  verify: VerifyResult;
  repair?: RepairResult;
  repairedFailures?: ClassifiedFailure[];
}

export interface OrchestratorDeps {
  plan: (prompt: string, ctx?: unknown, signal?: AbortSignal) => Promise<AppPlan> | AppPlan;
  needsClarification: (plan: AppPlan) => boolean;
  clarificationQuestion: (prompt: string) => string;
  /** Every long-running stage accepts an AbortSignal: fired the instant this stage's
   *  timeout elapses, so all Bedrock calls, repair loops, and pending verification
   *  actually stop instead of continuing in the background after being reported failed. */
  build: (plan: AppPlan, signal?: AbortSignal) => Promise<BuildResult>;
  /** previewUrl is only non-null on the THIRD (runtime) call, made after preview
   *  has actually started — that's what lets a real probe run and previewLoads
   *  stop being permanently null. The first two calls (pre-repair, post-repair)
   *  always pass undefined since no live server exists yet at that point. */
  verify: (plan: AppPlan, projectPath: string, previewUrl?: string | null, signal?: AbortSignal) => Promise<VerifyResult>;
  repair: (plan: AppPlan, projectPath: string, verify: VerifyResult, signal?: AbortSignal) => Promise<RepairResult>;
  /** Persist learnings. Only ever called on a verified-successful build. */
  learn: (input: LearnInput, signal?: AbortSignal) => Promise<unknown>;
  /** OPTIONAL safe preview: install deps + start a dev server, return a public URL. */
  startPreview?: (projectPath: string, signal?: AbortSignal) => Promise<{ url: string | null; started: boolean; error?: string }>;
  maxRepairAttempts?: number;
  /** Per-stage max duration in ms. Missing stages use DEFAULT_STAGE_TIMEOUTS. */
  timeouts?: Partial<Record<StageName, number>>;
  /** Live progress callback — fired at each stage start + on completion. Used by
   *  the SSE endpoint to stream real-time status to the UI. */
  onProgress?: (stage: StageName | 'done', message: string) => void;
}

export type StageName = 'plan' | 'build' | 'verify' | 'repair' | 'learn' | 'preview';

/** Hard caps so no stage can hang the request forever. */
export const DEFAULT_STAGE_TIMEOUTS: Record<StageName, number> = {
  plan: 30_000,      // 30s — deterministic; should be instant
  build: 600_000,    // 10 min — a full-app streaming generation legitimately exceeds
                     // the old 3-min cap; this stops premature FAILED while streaming.
  verify: 120_000,   // 2 min — static-only calls finish in ms; the runtime pass
                     // (after preview starts) needs headroom because Next.js
                     // dev mode compiles each route lazily on first request.
  repair: 240_000,   // 4 min — bounded ≤5 attempts, each a model call
  learn: 15_000,     // 15s — persistence
  preview: 240_000,  // 4 min — npm install + dev-server cold start
};

/**
 * Adaptive repair-stage timeout, confirmed necessary by live evidence: a
 * comprehensive 5-app stress test showed the static 240s repair budget is
 * OFTEN too tight for large failure batches (20-35 failures needing repair
 * in one iteration) — a single batched Bedrock call for such a batch alone
 * routinely took 90-130+ seconds, leaving no room for the 2nd-4th
 * iterations a full repair cycle typically needs to converge. This caused
 * partial convergence (real, correct fixes applied, but the stage timed
 * out before a later iteration could finish) in multiple apps even after
 * the repairer.ts stall-guard bug was fixed separately.
 *
 * Policy: small batches (<=SMALL_BATCH_THRESHOLD failures) keep the exact
 * existing behavior — same base timeout, zero change for the common case.
 * Above that, the timeout grows linearly with failure count (more failures
 * → bigger batches per Bedrock call and/or more iterations needed to
 * converge), capped so a single stage can never run unboundedly long.
 */
const REPAIR_SMALL_BATCH_THRESHOLD = 10;
const REPAIR_PER_EXTRA_FAILURE_MS = 8_000;
const REPAIR_MAX_TIMEOUT_MS = 600_000; // 10 min — matches the 'build' stage's own cap

export function computeRepairTimeout(
  failureCount: number,
  baseTimeoutMs: number = DEFAULT_STAGE_TIMEOUTS.repair,
  maxTimeoutMs: number = REPAIR_MAX_TIMEOUT_MS,
): number {
  if (failureCount <= REPAIR_SMALL_BATCH_THRESHOLD) return baseTimeoutMs;
  const extra = (failureCount - REPAIR_SMALL_BATCH_THRESHOLD) * REPAIR_PER_EXTRA_FAILURE_MS;
  return Math.min(baseTimeoutMs + extra, maxTimeoutMs);
}

export class StageTimeoutError extends Error {
  stage: StageName;
  ms: number;
  constructor(stage: StageName, ms: number) {
    super(`${stage} stage timed out after ${ms}ms`);
    this.name = 'StageTimeoutError';
    this.stage = stage;
    this.ms = ms;
  }
}

/**
 * Race a stage against its timeout AND actually cancel it on overrun.
 *
 * The previous version only stopped the caller from waiting — the underlying
 * `work` promise (a chain of real Bedrock calls / repair iterations / file
 * writes) kept running to completion in the background, silently consuming
 * Bedrock tokens and mutating the project folder for minutes after the stage
 * had already been reported as "failed: timed out". This version creates a
 * fresh AbortController per stage, passes its signal into `work`, and calls
 * `controller.abort()` the instant the timer fires — which propagates all the
 * way down to `AbortSignal`-aware AWS SDK calls (services/bedrock.ts), so the
 * in-flight HTTP request is cancelled at the network level, not just abandoned.
 */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T> | T, ms: number, stageName: StageName): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new StageTimeoutError(stageName, ms));
    }, ms);
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
  });
}

const internalRepairable = (v: VerifyResult): ClassifiedFailure[] =>
  v.classifiedFailures.filter(f => f.origin === 'internal' && f.repairable);

export async function runPipeline(prompt: string, deps: OrchestratorDeps, ctx?: unknown, sessionId?: string): Promise<OrchestratorResult> {
  const startedAt = new Date().toISOString();
  const logs: string[] = [];
  const sid = sessionId ? `[bs:${sessionId}] ` : '';
  const log = (m: string) => {
    const line = `[${new Date().toISOString()}] ${sid}${m}`;
    logs.push(line);
    // Mirror to the process log so build-session lines are greppable server-side.
    console.log(`[orchestrator]${sid ? ' ' + sid.trim() : ''} ${m}`);
  };

  const report = (status: EngineStatus, fields: Partial<EngineReport>, summary: string): OrchestratorResult => ({
    status, intent: null, plan: null, build: null, verify: null, repair: null,
    success: false, summary, startedAt, finishedAt: new Date().toISOString(), logs,
    buildStatus: 'failed', previewStatus: 'unavailable', verifyStatus: 'not_run', repairStatus: 'not_run',
    ...fields,
  });

  const T = (s: StageName) => deps.timeouts?.[s] ?? DEFAULT_STAGE_TIMEOUTS[s];
  // Run a stage under its timeout, logging start + duration. Throws StageTimeoutError
  // on overrun AND aborts the stage's signal so its work actually stops (see withTimeout).
  // timeoutOverride lets a call site (repair, see computeRepairTimeout below) use an
  // adaptive value instead of the stage's static default, without changing every
  // OTHER call to that same stage name.
  async function stage<R>(name: StageName, label: string, work: (signal: AbortSignal) => Promise<R> | R, timeoutOverride?: number): Promise<R> {
    const t0 = Date.now();
    const ms = timeoutOverride ?? T(name);
    log(`${name.toUpperCase()} ▶ ${label} (timeout ${ms}ms)`);
    deps.onProgress?.(name, label);
    const out = await withTimeout(work, ms, name);
    log(`${name.toUpperCase()} ✔ done in ${Date.now() - t0}ms`);
    return out;
  }

  // Partial state kept so a timeout can still return a useful report.
  let plan: AppPlan | null = null;
  let build: BuildResult | null = null;
  let verify: VerifyResult | null = null;
  let repair: RepairResult | undefined;
  let repairTimedOut = false;
  let previewUrl: string | null = null;
  let previewError: string | undefined;

  // Independent per-stage status — computed fresh from current state at every
  // return point. NONE of these gate each other: a verify/repair failure or
  // timeout must never hide a preview that actually started.
  const deriveStatuses = (): Pick<EngineReport, 'buildStatus' | 'previewStatus' | 'verifyStatus' | 'repairStatus'> => ({
    buildStatus: (build && build.filesCreated.length > 0 && build.isFreshFolder) ? 'success' : 'failed',
    previewStatus: previewUrl ? 'available' : 'unavailable',
    verifyStatus: verify == null ? 'not_run' : (verify.passed ? 'passed' : 'failed'),
    // Derived from the SAME trusted `verify` object verifyStatus uses — NOT
    // from repair.resolved, which is repair()'s own self-reported view and
    // can be wrong for runtime-only failures its internal loop couldn't see
    // (confirmed live: Car Rental Marketplace showed repairStatus=passed
    // while 1 internal-repairable failure genuinely remained, because
    // repair's internal re-verify was static-only at the time). This is
    // narrower than verifyStatus on purpose: repair's job is eliminating
    // internal+repairable failures specifically, not external issues or
    // performance budgets it was never asked to fix — "passed" here means
    // repair did its job, which can be true even while verifyStatus is
    // 'failed' for a reason outside repair's scope.
    repairStatus: !repair ? 'not_run' : (repairTimedOut ? 'timed_out' : ((verify && internalRepairable(verify).length === 0) ? 'passed' : 'failed')),
  });

  try {
    // ── PLAN ──────────────────────────────────────────────────────────────────
    plan = await stage('plan', 'classify intent + build AppPlan', (signal) => deps.plan(prompt, ctx, signal));
    log(`PLAN: type=${plan.intent.appType} (source ${plan.intent.source}); ${plan.pages.length} pages, ${plan.capabilities.length} capabilities`);

    if (deps.needsClarification(plan)) {
      const q = deps.clarificationQuestion(prompt);
      log('PLAN: request is unclear — requesting one clarification instead of building');
      return report('failed', { intent: plan.intent, plan, success: false }, `Clarification needed: ${q}`);
    }

    // ── BUILD ─────────────────────────────────────────────────────────────────
    build = await stage('build', 'generate real files into a fresh folder', (signal) => deps.build(plan as AppPlan, signal));
    log(`BUILD: ${build.filesCreated.length} file(s), fresh=${build.isFreshFolder}, recovered=${build.recoveredFromLooseFormat}`);

    if (build.filesCreated.length === 0 || !build.isFreshFolder) {
      log('BUILD: no real files produced (spec/prose only) or folder not fresh — failing');
      return report('failed', { intent: plan.intent, plan, build, success: false, ...deriveStatuses() }, 'Build produced no usable files.');
    }

    // ── VERIFY #1 ─────────────────────────────────────────────────────────────
    // Wrapped locally: build already succeeded (real files exist), so a verify
    // failure or timeout must not throw away the chance to still reach preview.
    let repairedFailures: ClassifiedFailure[] = [];
    try {
      verify = await stage('verify', 'structural analysis (static — no live server yet)', (signal) => deps.verify(plan as AppPlan, (build as BuildResult).projectPath, undefined, signal));
      log(`VERIFY: passed=${verify.passed}; internalFailures=${internalRepairable(verify).length}; externalIssues=${verify.externalIssues.length}`);
    } catch (e) {
      const msg = e instanceof StageTimeoutError ? `timed out after ${e.ms}ms` : (e instanceof Error ? e.message : String(e));
      log(`VERIFY: did not complete — ${msg}. Build has real files, so preview will still be attempted.`);
      verify = null;
    }

    // ── REPAIR (internal only; never external) ──────────────────────────────────
    // Also wrapped locally: a repair failure or timeout is reported as its own
    // status (repairStatus: 'failed' | 'timed_out') and must not block preview.
    const initialInternal = verify ? internalRepairable(verify) : [];
    if (verify && !verify.passed && initialInternal.length > 0) {
      try {
        const repairTimeout = computeRepairTimeout(initialInternal.length, T('repair'));
        if (repairTimeout > T('repair')) {
          log(`REPAIR: adaptive timeout ${repairTimeout}ms (base ${T('repair')}ms) — ${initialInternal.length} failures exceeds the ${REPAIR_SMALL_BATCH_THRESHOLD}-failure small-batch threshold`);
        }
        repair = await stage('repair', `bounded repair of ${initialInternal.length} internal failure(s)`, (signal) => deps.repair(plan as AppPlan, (build as BuildResult).projectPath, verify as VerifyResult, signal), repairTimeout);
        log(`REPAIR: attempts=${repair.attempts}/${repair.maxAttempts}, resolved=${repair.resolved}, changedFiles=${repair.changedFiles.length}, skippedExternal=${repair.skippedExternalIssues.length}, stopReason=${repair.stopReason ?? 'n/a'}`);

        try {
          const finalVerify = await stage('verify', 're-verify after repair (static)', (signal) => deps.verify(plan as AppPlan, (build as BuildResult).projectPath, undefined, signal));
          const finalInternalDetails = new Set(internalRepairable(finalVerify).map(f => f.detail));
          repairedFailures = initialInternal.filter(f => !finalInternalDetails.has(f.detail));
          verify = finalVerify;
          log(`VERIFY: passed=${verify.passed}; remainingInternal=${internalRepairable(verify).length}`);
        } catch (e) {
          const msg = e instanceof StageTimeoutError ? `timed out after ${e.ms}ms` : (e instanceof Error ? e.message : String(e));
          log(`VERIFY (post-repair): did not complete — ${msg}. Keeping pre-repair verify result.`);
        }
      } catch (e) {
        if (e instanceof StageTimeoutError) {
          repairTimedOut = true;
          log(`REPAIR: TIMED OUT after ${e.ms}ms — continuing pipeline (build already has real files; preview will still be attempted).`);
        } else {
          log(`REPAIR: did not complete — ${e instanceof Error ? e.message : String(e)}. Continuing pipeline.`);
        }
        repair = {
          attempts: 0, maxAttempts: deps.maxRepairAttempts ?? 5, changedFiles: [], resolved: false,
          remainingIssues: initialInternal.map(f => f.detail), skippedExternalIssues: [],
          stopReason: repairTimedOut ? `timed out after repair stage exceeded its time budget` : 'repair stage errored before completing',
        };
      }
    } else if (verify && !verify.passed) {
      log('REPAIR: skipped — remaining issues are external/non-repairable');
    }

    // ── PREVIEW (safe, best-effort; never aborts the pipeline) ──────────────────
    // Starts a dev server for the freshly built project and returns a public URL.
    // Timeout-protected and fully caught, so a slow/failed preview reports an exact
    // error instead of spinning forever. Runs BEFORE the runtime verify pass below
    // and BEFORE the success/learn calculation — a verify/repair failure must never
    // hide a preview that actually started.
    if (deps.startPreview && build.filesCreated.length > 0) {
      try {
        const pv = await stage('preview', 'install deps + start dev server', (signal) => deps.startPreview!((build as BuildResult).projectPath, signal));
        previewUrl = pv.url;
        if (!pv.started) previewError = pv.error;
        log(`PREVIEW: ${pv.started ? 'started ' + pv.url : 'not started — ' + (pv.error ?? 'unknown')}`);
      } catch (e) {
        previewError = e instanceof StageTimeoutError ? `preview timed out after ${e.ms}ms` : (e instanceof Error ? e.message : String(e));
        log(`PREVIEW: failed — ${previewError}`);
      }
    }

    // ── VERIFY #3 (runtime — against the LIVE preview) ──────────────────────────
    // This is what lets `passed` become true at all: previewLoads can only be
    // measured against a real running server, which didn't exist during the two
    // static passes above. Purely additive — if preview never started, or this
    // pass itself errors/times out, the pipeline keeps whatever verify result it
    // already has (static-only) rather than losing progress or blocking anything.
    if (previewUrl) {
      // startPreview only confirms the TCP PORT is accepting connections (see
      // project-runner.ts's startDevServer, which explicitly logs "compiling —
      // preview will load in ~60s" for exactly this reason) — it says nothing
      // about whether Next.js has finished its initial compile and can actually
      // route pages yet. Probing immediately produces spurious 404s on every
      // route (confirmed live: previewLoads=false with ALL routes 404 at the
      // instant preview reported "started", while the SAME routes succeeded
      // moments later in the workflow tests) — a false negative, not a real bug.
      // Poll the home page until it responds or this warm-up window elapses;
      // non-fatal either way, since a real, persistent failure will still show
      // up honestly in the verify pass that follows.
      const warmupT0 = Date.now();
      let warmedUp = false;
      while (Date.now() - warmupT0 < 90_000) {
        try {
          const res = await fetch(previewUrl, { signal: AbortSignal.timeout(5000) });
          if (res.status >= 200 && res.status < 400) { warmedUp = true; break; }
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 2000));
      }
      log(`PREVIEW: warm-up ${warmedUp ? `ready after ${Date.now() - warmupT0}ms` : `did not respond within ${Date.now() - warmupT0}ms — proceeding to verify anyway`}`);

      try {
        const runtimeVerify = await stage('verify', 'runtime verification against live preview', (signal) => deps.verify(plan as AppPlan, (build as BuildResult).projectPath, previewUrl, signal));
        verify = runtimeVerify;
        log(`VERIFY (runtime): passed=${verify.passed}; previewLoads=${verify.previewLoads}; internalFailures=${internalRepairable(verify).length}`);
      } catch (e) {
        const msg = e instanceof StageTimeoutError ? `timed out after ${e.ms}ms` : (e instanceof Error ? e.message : String(e));
        log(`VERIFY (runtime): did not complete — ${msg}. Keeping prior static verify result — preview remains available regardless.`);
      }

      // ── REPAIR #2 (runtime-only failures) ─────────────────────────────────────
      // Auth workflow/security failures (and anything else only detectable once
      // a live server exists — e.g. an actual 500 from calling a nonexistent
      // export) are invisible to both static verify passes, so nothing could
      // have repaired them before this point. Bounded to ONE additional cycle:
      // this closes out a fresh class of failure the static passes structurally
      // cannot see, not an unbounded retry loop. Never blocks preview — it's
      // already available regardless of this cycle's outcome.
      const runtimeInternal = verify && !verify.passed ? internalRepairable(verify) : [];
      if (runtimeInternal.length > 0) {
        try {
          const repairTimeout2 = computeRepairTimeout(runtimeInternal.length, T('repair'));
          if (repairTimeout2 > T('repair')) {
            log(`REPAIR (runtime): adaptive timeout ${repairTimeout2}ms (base ${T('repair')}ms) — ${runtimeInternal.length} failures exceeds the ${REPAIR_SMALL_BATCH_THRESHOLD}-failure small-batch threshold`);
          }
          const repair2 = await stage('repair', `bounded repair of ${runtimeInternal.length} runtime-detected failure(s)`, (signal) => deps.repair(plan as AppPlan, (build as BuildResult).projectPath, verify as VerifyResult, signal), repairTimeout2);
          log(`REPAIR (runtime): attempts=${repair2.attempts}/${repair2.maxAttempts}, resolved=${repair2.resolved}, changedFiles=${repair2.changedFiles.length}, stopReason=${repair2.stopReason ?? 'n/a'}`);
          repair = repair2;

          try {
            const reverify = await stage('verify', 're-verify after runtime repair', (signal) => deps.verify(plan as AppPlan, (build as BuildResult).projectPath, previewUrl, signal));
            const stillFailing = new Set(internalRepairable(reverify).map(f => f.detail));
            repairedFailures.push(...runtimeInternal.filter(f => !stillFailing.has(f.detail)));
            verify = reverify;
            log(`VERIFY (post-runtime-repair): passed=${verify.passed}; previewLoads=${verify.previewLoads}; remainingInternal=${internalRepairable(verify).length}`);
          } catch (e) {
            const msg = e instanceof StageTimeoutError ? `timed out after ${e.ms}ms` : (e instanceof Error ? e.message : String(e));
            log(`VERIFY (post-runtime-repair): did not complete — ${msg}. Keeping the runtime verify result from before this repair pass.`);
          }
        } catch (e) {
          if (e instanceof StageTimeoutError) {
            repairTimedOut = true;
            log(`REPAIR (runtime): TIMED OUT after ${e.ms}ms — continuing pipeline (preview remains available regardless).`);
          } else {
            log(`REPAIR (runtime): did not complete — ${e instanceof Error ? e.message : String(e)}. Continuing pipeline.`);
          }
        }
      }
    }

    // ── SUCCESS RULE ────────────────────────────────────────────────────────────
    // Kept for the single "all-clear" banner. Individual stage statuses (below,
    // via deriveStatuses) are what gate the UI now — this no longer gates preview.
    const success = verify?.passed === true && build.isFreshFolder && build.filesCreated.length > 0;

    if (success) {
      try {
        await stage('learn', 'persist architecture decision + repair patterns', (signal) => deps.learn({ plan: plan as AppPlan, verify: verify as VerifyResult, repair, repairedFailures }, signal));
      } catch (e) {
        log(`LEARN: failed (non-fatal) — ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log('LEARN: skipped — build not verified-successful');
    }

    const status: EngineStatus = success ? 'complete' : 'failed';
    const summary = success
      ? `Complete: ${plan.displayName} — ${build.filesCreated.length} files, ${(verify as VerifyResult).routes.length} routes, all checks passed${(verify as VerifyResult).externalIssues.length ? ` (${(verify as VerifyResult).externalIssues.length} external issue(s) reported)` : ''}.`
      : verify
        ? `Build ${build.filesCreated.length} file(s) (fresh). Verify: ${verify.buildErrors.length} build error(s), ${verify.deadLinks.length} dead link(s), ${internalRepairable(verify).length} unresolved internal issue(s)${verify.externalIssues.length ? `, ${verify.externalIssues.length} external issue(s)` : ''}. Repair: ${repairTimedOut ? 'timed out' : repair ? (repair.resolved ? 'resolved' : 'incomplete') : 'not run'}.${previewUrl ? ' Preview is available for manual testing.' : ''}`
        : `Build ${build.filesCreated.length} file(s) (fresh), but verification did not complete.${previewUrl ? ' Preview is available for manual testing.' : ''}`;
    log(`DONE: status=${status}`);
    deps.onProgress?.('done', summary);

    return { status, intent: plan.intent, plan, build, verify, repair: repair ?? null, success, summary, previewUrl, previewError, startedAt, finishedAt: new Date().toISOString(), logs, ...deriveStatuses() };
  } catch (err) {
    // Timeout or unexpected stage failure → fail FAST with a clear blocking reason,
    // returning whatever partial facts we have. Never spin forever.
    if (err instanceof StageTimeoutError) {
      log(`TIMEOUT: ${err.stage} stage exceeded ${err.ms}ms — aborting`);
      return report('failed', { intent: plan?.intent ?? null, plan, build, verify, success: false, ...deriveStatuses() },
        `Blocked: the ${err.stage} stage timed out after ${err.ms}ms. ${err.stage === 'build' ? 'Likely the AI model (Bedrock) was slow/unreachable or credentials are missing.' : 'A stage exceeded its time budget.'} No partial app was reported as complete.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: pipeline failed — ${msg}`);
    return report('failed', { intent: plan?.intent ?? null, plan, build, verify, success: false, ...deriveStatuses() }, `Blocked: ${msg}`);
  }
}

// ── Default (production) wiring — lazy, imported by nobody else. Not connected
//    to /api/chat. Verify runs statically for the first two passes (no server
//    exists yet) and with a real HTTP probe for the third, runtime pass once
//    a previewUrl is supplied (see http-probe.ts's makeHttpProbe). ───────────
export async function defaultOrchestratorDeps(readProjectFiles: (projectPath: string) => Promise<{ path: string; content: string }[]>): Promise<OrchestratorDeps> {
  const { createPlan, needsClarification, clarificationQuestion } = await import('./planner');
  const { classifyIntentWithModel, defaultModelClassifierDeps } = await import('./model-classifier');
  const { buildApp, defaultBuilderDeps } = await import('./builder');
  const { verifyApp } = await import('./verifier');
  const { repair, defaultRepairerDeps } = await import('./repairer');
  const { learnFromBuild, inMemoryLearnerStore } = await import('./learner');
  const { makeHttpProbe } = await import('./http-probe');
  const builderDeps = await defaultBuilderDeps();
  // Single source of truth for "is the live app healthy": this same closure
  // variable is read by repairerDeps's own verify below (via getPreviewUrl),
  // so repair's internal re-verify loop becomes runtime-aware the MOMENT
  // preview actually starts — not a second, independently-computed view that
  // can silently disagree with the orchestrator's own verify calls.
  let currentPreviewUrl: string | null = null;
  const repairerDeps = await defaultRepairerDeps({ readProjectFiles, getPreviewUrl: () => currentPreviewUrl });
  const store = inMemoryLearnerStore();
  const modelClassifierDeps = await defaultModelClassifierDeps();
  return {
    plan: async (prompt, ctx, signal) => {
      // Try model-based classification first (scales to any phrasing without
      // per-variant keyword tuning — see model-classifier.ts). On any failure,
      // timeout, or an unconfident/unrecognized answer it returns null, and
      // createPlan falls through to today's proven keyword classification —
      // this can only make classification better or the same, never worse.
      const modelIntent = await classifyIntentWithModel(prompt, modelClassifierDeps, signal).catch(() => null);
      const baseCtx = (ctx as Record<string, unknown> | undefined) ?? {};
      return createPlan(prompt, { ...baseCtx, ...(modelIntent ? { modelIntent } : {}) });
    },
    needsClarification: (plan) => needsClarification(plan.intent),
    clarificationQuestion,
    build: (plan, signal) => buildApp(plan, builderDeps, signal),
    verify: (plan, projectPath, previewUrl, signal) => verifyApp(
      plan, projectPath,
      previewUrl ? { readProjectFiles, probe: makeHttpProbe(previewUrl), previewUrl } : { readProjectFiles },
      signal,
    ),
    repair: (plan, projectPath, v, signal) => repair(plan, projectPath, v, repairerDeps, signal),
    learn: (input) => learnFromBuild(input, store), // persistence is fast/local — not worth cancelling mid-write
    // Safe preview: reuse the low-level dev-server runner (NOT the old build UI flow).
    // Fully wrapped — returns an exact error instead of hanging.
    startPreview: async (projectPath, signal) => {
      const plog = (m: string) => console.log(`[builder][preview][${new Date().toISOString()}] ${m}`);
      try {
        const { installDependencies, startDevServer } = await import('@/services/project-runner');
        plog('npm install started');
        const iT0 = Date.now();
        const inst = await installDependencies(projectPath, [], signal);
        plog(`npm install completed in ${Date.now() - iT0}ms — success=${inst.success}`);
        if (!inst.success) return { url: null, started: false, error: `npm install failed: ${inst.error ?? 'unknown'}` };
        if (signal?.aborted) return { url: null, started: false, error: 'Cancelled — preview stage was aborted' };
        plog('preview server start started');
        const sT0 = Date.now();
        const srv = await startDevServer(projectPath);
        plog(`preview server start completed in ${Date.now() - sT0}ms — port=${srv.port ?? 'none'}`);
        if (!srv.port) return { url: null, started: false, error: srv.error ?? 'dev server did not start' };
        const domain = process.env.PREVIEW_DOMAIN?.trim();
        const url = domain ? `https://preview.${domain}` : `http://localhost:${srv.port}`;
        currentPreviewUrl = url; // repairerDeps's getPreviewUrl reads this from here on
        return { url, started: true };
      } catch (e) {
        plog(`preview error — ${e instanceof Error ? e.message : String(e)}`);
        return { url: null, started: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    maxRepairAttempts: 5,
  };
}

/**
 * Production entrypoint used by the new `engine-build` action. Reads generated
 * project files from disk for STATIC verification (no localhost probe yet).
 * `depsOverride` exists only for isolated tests.
 */
export async function runEngineBuild(
  prompt: string,
  ctx?: unknown,
  depsOverride?: OrchestratorDeps,
  onProgress?: OrchestratorDeps['onProgress'],
  sessionId?: string,
): Promise<OrchestratorResult> {
  if (depsOverride) return runPipeline(prompt, { ...depsOverride, onProgress: onProgress ?? depsOverride.onProgress }, ctx, sessionId);

  const { readFile, readdir, stat } = await import('fs/promises');
  const { join } = await import('path');
  const SKIP = new Set(['node_modules', '.next', '.git', '.dwomoh']);
  const readProjectFiles = async (projectPath: string): Promise<{ path: string; content: string }[]> => {
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
  };

  const deps = await defaultOrchestratorDeps(readProjectFiles);
  if (onProgress) deps.onProgress = onProgress;
  return runPipeline(prompt, deps, ctx, sessionId);
}
