/**
 * DWOMOH VIBE CODE — Repairer Engine (Step 5).
 *
 * Consumes a VerifyResult and fixes ONLY internal + repairable failures, in a
 * bounded loop (≤5 attempts), re-running verification after every attempt.
 * External provider failures (Cognito/Bedrock/Paystack/MTN MoMo/… 5xx, timeouts)
 * are NEVER repaired — they are skipped and reported. The Repairer returns a
 * RepairResult of facts only and NEVER marks the build complete (the orchestrator
 * decides completion from the Verifier).
 *
 * Standalone: imports only the type contract. All I/O is injected:
 *   - applyFix : performs ONE targeted fix for a single internal failure
 *   - verify   : re-runs the Verifier and returns a fresh VerifyResult
 * so the loop logic is fully unit-testable without Bedrock or a live server.
 */
import type {
  AppPlan, ClassifiedFailure, ExternalServiceIssue, RepairResult, VerifyResult,
} from './types';

export interface ApplyFixResult { changedFiles: string[] }

export interface RepairerDeps {
  /** Targeted fix for ONE internal failure. Must touch only related files. */
  applyFix: (plan: AppPlan, failure: ClassifiedFailure, projectPath: string, signal?: AbortSignal) => Promise<ApplyFixResult>;
  /**
   * OPTIONAL: fix an entire iteration's failures in as few calls as possible
   * (e.g. one combined Bedrock request instead of one per failure). When
   * provided, the loop uses this instead of calling applyFix once per failure —
   * this is what lets a repair pass with many small issues (missing routes,
   * placeholder pages) actually converge inside the stage timeout instead of
   * making N sequential round-trips. Falls back to per-failure applyFix when absent.
   */
  applyFixBatch?: (plan: AppPlan, failures: ClassifiedFailure[], projectPath: string, signal?: AbortSignal) => Promise<ApplyFixResult>;
  /** Re-run verification and return a fresh VerifyResult. */
  verify: (plan: AppPlan, projectPath: string, signal?: AbortSignal) => Promise<VerifyResult>;
  /** Bounded loop cap. Default 5. */
  maxAttempts?: number;
}

const internalRepairable = (v: VerifyResult): ClassifiedFailure[] =>
  v.classifiedFailures.filter(f => f.origin === 'internal' && f.repairable);

function mergeExternal(into: ExternalServiceIssue[], from: ExternalServiceIssue[]): void {
  for (const e of from) {
    if (!into.some(s => s.service === e.service && s.message === e.message && s.httpStatus === e.httpStatus)) into.push(e);
  }
}

export async function repair(
  plan: AppPlan,
  projectPath: string,
  initial: VerifyResult,
  deps: RepairerDeps,
  signal?: AbortSignal,
): Promise<RepairResult> {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 5);
  const changedFiles = new Set<string>();
  const skippedExternalIssues: ExternalServiceIssue[] = [];
  const iterations: { attempt: number; targeted: string[]; changedFiles: string[] }[] = [];
  const log = (m: string) => console.log(`[repairer] ${new Date().toISOString()} ${m}`);
  const describe = (f: ClassifiedFailure) => `${f.area}: ${f.detail}`;

  let current = initial;
  mergeExternal(skippedExternalIssues, current.externalIssues); // report external from the start
  let attempts = 0;
  let stopReason = 'resolved';

  // ── Task 4/5: skip Repair entirely when nothing is actionable ────────────────
  // No internal+repairable failures → do NOT call Bedrock at all. This is the case
  // when the Verifier reports only passing checks (or only external issues).
  const initialActionable = internalRepairable(current);
  if (initialActionable.length === 0) {
    log('SKIP — no internal+repairable failures. Not invoking Bedrock. ' +
        `(passed=${current.passed}, external=${current.externalIssues.length})`);
    return {
      attempts: 0,
      maxAttempts,
      changedFiles: [],
      resolved: true,
      remainingIssues: [],
      skippedExternalIssues,
      stopReason: 'skipped — no actionable internal issues',
      iterations: [],
    };
  }

  log(`START — ${initialActionable.length} internal failure(s) to repair, maxAttempts=${maxAttempts}`);
  let prevRemaining = -1;

  outer: while (attempts < maxAttempts) {
    if (signal?.aborted) {
      stopReason = 'cancelled — orchestrator aborted this stage';
      log(`ABORT detected before iteration ${attempts + 1} — EXIT (${stopReason})`);
      break;
    }

    const toFix = internalRepairable(current);
    if (toFix.length === 0) { stopReason = 'all internal issues resolved'; break; }
    if (current.passed) { stopReason = 'verification passed'; break; }

    attempts++;
    const targeted = toFix.map(describe);
    // Task 2 + 3: log why this attempt starts and which verifier failures triggered it.
    log(`iteration ${attempts}/${maxAttempts} START — triggered by ${toFix.length} failure(s): ${targeted.join(' | ')}`);

    const iterChanged = new Set<string>();
    if (deps.applyFixBatch) {
      // Batched path: fix this whole iteration's failures in as few Bedrock
      // calls as possible instead of one round-trip per failure.
      if (signal?.aborted) {
        stopReason = 'cancelled — orchestrator aborted this stage';
        log(`ABORT detected before iteration ${attempts} batch fix — EXIT (${stopReason})`);
        iterations.push({ attempt: attempts, targeted, changedFiles: [] });
        break outer;
      }
      log(`  → batch-fixing ${toFix.length} failure(s) in as few call(s) as possible`);
      try {
        const res = await deps.applyFixBatch(plan, toFix, projectPath, signal);
        res.changedFiles.forEach(c => { changedFiles.add(c); iterChanged.add(c); });
        log(`    applyFixBatch changed ${res.changedFiles.length} file(s): ${res.changedFiles.join(', ') || '(none)'}`);
      } catch (e) {
        if (signal?.aborted) {
          stopReason = 'cancelled — orchestrator aborted this stage';
          log(`ABORT during applyFixBatch — EXIT (${stopReason})`);
          iterations.push({ attempt: attempts, targeted, changedFiles: [...iterChanged] });
          break outer;
        }
        log(`    applyFixBatch error (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      for (const failure of toFix) {
        // Checked BEFORE every single fix (not just between iterations) — this is
        // the exact point where a live run kept calling Bedrock for several more
        // fixes after the orchestrator had already reported the stage as timed out.
        if (signal?.aborted) {
          stopReason = 'cancelled — orchestrator aborted this stage';
          log(`ABORT detected mid-iteration ${attempts} (before fixing "${failure.detail}") — EXIT (${stopReason})`);
          iterations.push({ attempt: attempts, targeted, changedFiles: [...iterChanged] });
          break outer;
        }
        log(`  → fixing (${failure.area}) ${failure.detail}`);
        try {
          const res = await deps.applyFix(plan, failure, projectPath, signal);
          res.changedFiles.forEach(c => { changedFiles.add(c); iterChanged.add(c); });
          log(`    applyFix changed ${res.changedFiles.length} file(s): ${res.changedFiles.join(', ') || '(none)'}`);
        } catch (e) {
          if (signal?.aborted) {
            stopReason = 'cancelled — orchestrator aborted this stage';
            log(`ABORT during applyFix for "${failure.detail}" — EXIT (${stopReason})`);
            iterations.push({ attempt: attempts, targeted, changedFiles: [...iterChanged] });
            break outer;
          }
          log(`    applyFix error (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // ── Strategy escalation: batch produced nothing → retry per-failure ────────
    // A whole-iteration batch call can fail to produce ANY usable edit for
    // reasons that don't apply equally to every failure in it — one bad path
    // in a multi-file response, a single malformed edit block, a truncated
    // reply — while a SIMPLER, single-failure prompt (less context to track,
    // one target instead of several) can still succeed. Retry once, per
    // failure, before concluding the whole iteration is unfixable — this is
    // what turns "no code changes produced" from an immediate dead end into
    // an actual second attempt with a different strategy.
    if (iterChanged.size === 0 && deps.applyFixBatch && !signal?.aborted) {
      log(`  batch produced no changes — escalating to per-failure retry for ${toFix.length} failure(s)`);
      for (const failure of toFix) {
        if (signal?.aborted) break;
        try {
          const res = await deps.applyFix(plan, failure, projectPath, signal);
          res.changedFiles.forEach(c => { changedFiles.add(c); iterChanged.add(c); });
          if (res.changedFiles.length > 0) {
            log(`    per-failure retry fixed "${failure.detail}" — changed ${res.changedFiles.length} file(s): ${res.changedFiles.join(', ')}`);
          }
        } catch (e) {
          log(`    per-failure retry error for "${failure.detail}" (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    iterations.push({ attempt: attempts, targeted, changedFiles: [...iterChanged] });

    // ── Task 7: exit immediately when an iteration produces NO code changes ─────
    // If applyFix couldn't modify anything EVEN after the per-failure escalation
    // above, re-running the model won't help — stop rather than burning more
    // slow Bedrock calls against an unfixable failure.
    if (iterChanged.size === 0) {
      stopReason = 'no code changes produced — stopping to avoid unbounded Bedrock retries';
      log(`iteration ${attempts} produced NO file changes (batch + per-failure retry both empty) — EXIT (${stopReason})`);
      break;
    }

    if (signal?.aborted) {
      stopReason = 'cancelled — orchestrator aborted this stage';
      log(`ABORT detected before re-verify (iteration ${attempts}) — EXIT (${stopReason})`);
      break;
    }

    // Re-run verification AFTER every attempt.
    current = await deps.verify(plan, projectPath, signal);
    mergeExternal(skippedExternalIssues, current.externalIssues);
    const remainingList = internalRepairable(current);
    const remaining = remainingList.length;
    log(`iteration ${attempts} DONE — passed=${current.passed}, remainingInternal=${remaining}, filesChangedThisIter=${iterChanged.size}`);
    // Requirement 8: show the EXACT remaining issues after this attempt.
    if (remaining > 0) remainingList.forEach((f, i) => log(`    remaining[${i + 1}/${remaining}] (${f.area}) ${f.detail}`));
    else log('    remaining: none — all internal issues resolved.');

    if (current.passed) { stopReason = 'verification passed'; break; }
    if (remaining === 0) { stopReason = 'all internal issues resolved'; break; }

    // ── Task 7 (stall guard): consecutive iterations with no reduction → stop ───
    if (prevRemaining !== -1 && remaining >= prevRemaining) {
      stopReason = 'no progress across consecutive iterations — stopping';
      log(`no reduction in remaining issues (${prevRemaining} → ${remaining}) — EXIT (${stopReason})`);
      break;
    }
    prevRemaining = remaining;
  }


  const remainingInternal = internalRepairable(current);
  if (attempts >= maxAttempts && remainingInternal.length > 0) {
    stopReason = `reached maximum repair iterations (${maxAttempts})`;
  }

  // Task 8: report iterations, files-modified-per-iteration, and reason for stopping.
  log(`FINISHED — attempts=${attempts}/${maxAttempts}, totalFilesChanged=${changedFiles.size}, ` +
      `remainingInternal=${remainingInternal.length}, stopReason="${stopReason}"`);
  iterations.forEach(it =>
    log(`  · iter ${it.attempt}: ${it.changedFiles.length} file(s) changed — ${it.changedFiles.join(', ') || '(none)'}`));

  return {
    attempts,
    maxAttempts,
    changedFiles: [...changedFiles],
    // The Repairer's job is done when no internal+repairable failures remain.
    // (Whether the build is "complete" is the orchestrator's call via verify.passed.)
    resolved: remainingInternal.length === 0,
    remainingIssues: current.classifiedFailures
      .filter(f => f.origin === 'internal')
      .map(f => f.detail),
    skippedExternalIssues,
    stopReason,
    iterations,
  };
}

interface FastPathOpts {
  readProjectFiles: (projectPath: string) => Promise<{ path: string; content: string }[]>;
}

/**
 * Whether two paths refer to the "same" file for matching purposes. Exact
 * match, OR (to tolerate prefix differences like a missing "src/") at least
 * the last TWO path segments overlap — a bare filename like "page.tsx" must
 * never satisfy a full path like "app/vendor/[id]/page.tsx".
 *
 * Confirmed via live testing this was a real bug: the old check was
 * `a.endsWith(b) || b.endsWith(a)`, which is true for ANY bare filename
 * against ANY path ending in that filename. A repair batch call returned a
 * file literally named "page.tsx" (no directory), the old check accepted it
 * as satisfying "app/vendor/[id]/page.tsx", the fix got written to the wrong
 * location, and the real target file was never created — so the exact same
 * "Planned file missing" failure persisted and the repair loop's stall-guard
 * gave up on an issue that was never actually attempted correctly.
 */
export function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const segsA = a.split('/').filter(Boolean);
  const segsB = b.split('/').filter(Boolean);
  if (segsA.length < 2 || segsB.length < 2) return false; // no room for a meaningful overlap
  return segsA.slice(-2).join('/') === segsB.slice(-2).join('/');
}

/**
 * Deterministic, zero-Bedrock-cost fixes shared by applyFix and applyFixBatch.
 * Returns null when the failure doesn't match a known free-fix shape, so the
 * caller falls through to a model-generated fix.
 */
async function tryFastPathFix(
  plan: AppPlan, failure: ClassifiedFailure, projectPath: string, opts: FastPathOpts,
): Promise<ApplyFixResult | null> {
  // A dead link gets a deterministic stub page — the exact same generator used
  // at build time (services/project-generator.ts buildRouteStub). A missing
  // nav target never needs AI just to stop being a 404.
  const deadLinkMatch = failure.area === 'runtime' ? failure.detail.match(/^Dead link \/ 404 risk: (\/\S*)$/) : null;
  if (deadLinkMatch) {
    const route = deadLinkMatch[1];
    const { buildRouteStub } = await import('@/services/project-generator');
    const files = await opts.readProjectFiles(projectPath);
    const hasAuthGroup = files.some(f => f.path.includes('app/(auth)/'));
    const { filePath, content } = buildRouteStub(route, hasAuthGroup);
    const { writeFile, mkdir } = await import('fs/promises');
    const { join, dirname } = await import('path');
    const abs = join(projectPath, filePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return { changedFiles: [filePath] };
  }

  // A missing API route matching the standard list/detail CRUD shape
  // (planner.ts's planApiRoutes) gets a real, working handler from a
  // deterministic template — zero Bedrock cost.
  const missingApiMatch = failure.area === 'structural' ? failure.detail.match(/^Planned file missing: (app\/api\/\S+\/route\.[jt]sx?)$/) : null;
  if (missingApiMatch) {
    const apiRoute = plan.apiRoutes.find(r => r.filePath === missingApiMatch[1]);
    const { buildCrudRoute } = await import('./crud-template');
    const crud = apiRoute ? buildCrudRoute(apiRoute, plan.dataModels) : null;
    if (crud) {
      const { writeFile, mkdir } = await import('fs/promises');
      const { join, dirname } = await import('path');
      const abs = join(projectPath, crud.filePath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, crud.content, 'utf8');
      return { changedFiles: [crud.filePath] };
    }
  }

  // Generic Integration Registry dispatch — a failure the Verifier raised
  // via a registered IntegrationRule (api-registration, middleware-
  // protection, navigation, dashboard-widgets, breadcrumbs, ...) carries
  // that rule's id, so repair here is a single generic lookup-and-apply
  // rather than one hand-coded regex-match block per integration type.
  // Adding a new integration going forward means writing a rule in
  // integration-rules.ts — this function never needs to change.
  if (failure.integrationId) {
    const { findRule } = await import('./integration-registry');
    await import('./integration-rules'); // side-effect: registers every concrete rule
    const rule = findRule(failure.integrationId);
    if (rule) {
      const files = await opts.readProjectFiles(projectPath);
      // Several rules' apply() (navigation, dashboard-widgets) need to know
      // WHICH file to read/patch — reuses describeTarget()'s existing
      // trailing-file-path extraction rather than hardcoding an empty
      // targetFile, which silently made every such apply() decline.
      const { targetPath } = describeTarget(plan, failure);
      const ctx = {
        plan, files, fileSet: new Set(files.map(f => f.path)),
        // apply() implementations parse what they need from the gap's own
        // detail/targetFile (same convention as every other fast path in
        // this file) rather than reading routes/apiRoutes — see
        // integration-rules.ts's module doc for why that keeps this call
        // site simple instead of needing route-resolution logic here too.
        routes: [] as string[], apiRoutes: [] as string[],
      };
      const gap = { integrationId: failure.integrationId, detail: failure.detail, targetFile: targetPath ?? '' };
      const result = await rule.apply(gap, projectPath, ctx);
      if (result) return result;
    }
  }

  // Auth workflow/security failures (signup/login/protected-route) carry no
  // file path in their detail — they describe BEHAVIOR, not a specific file
  // — so the usual describeTarget() path-extraction can't act on them. But
  // the fix is deterministic: these failures are the exact symptom of a
  // generated auth route using the wrong lib/managed/auth.ts contract (see
  // auth-template.ts's header for the full pattern, confirmed across 5 live
  // apps this session). Re-injecting the known-correct templates resolves it
  // without a Bedrock call, and far more reliably than hoping a fresh model
  // response gets the same contract right this time.
  // Deliberately does NOT match "Protected API rejects unauthorized" — that
  // failure is about a SPECIFIC business API route not checking auth (e.g.
  // /api/orders), which neither middleware.ts (its matcher explicitly
  // excludes /api/*) nor the auth-template routes touch. Re-injecting the
  // auth templates for it would silently "resolve" the failure without
  // fixing anything — confirmed live: it matched the old broader regex,
  // got fast-pathed, and the underlying route was still unprotected on
  // re-verify. That failure now carries its own file path (see verifyApp's
  // addInternal loop) and falls through to the model-based repair instead.
  const AUTH_FAILURE_RE = /^(Workflow failed: User (signup|login)|Workflow failed: Protected route blocks anonymous|Security failed: Protected page requires auth)$/;
  if (AUTH_FAILURE_RE.test(failure.detail)) {
    const { buildAuthRoutes, buildMiddleware, deriveProtectedRoutes } = await import('./auth-template');
    const { fileToRoute } = await import('./verifier');
    const { writeFile, mkdir } = await import('fs/promises');
    const { join, dirname } = await import('path');
    const files = await opts.readProjectFiles(projectPath);
    const changedFiles: string[] = [];

    for (const f of buildAuthRoutes()) {
      const abs = join(projectPath, f.filePath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, 'utf8');
      changedFiles.push(f.filePath);
    }

    const pageRoutes = files
      .filter(pf => /\/page\.[jt]sx?$/.test(pf.path))
      .map(pf => fileToRoute(pf.path))
      .filter((r): r is string => r !== null);
    const mw = buildMiddleware(deriveProtectedRoutes(pageRoutes));
    const mwAbs = join(projectPath, mw.filePath);
    await mkdir(dirname(mwAbs), { recursive: true });
    await writeFile(mwAbs, mw.content, 'utf8');
    changedFiles.push(mw.filePath);

    return { changedFiles };
  }

  return null;
}

/** Which file a failure targets, and the plan context for prompting about it. */
function describeTarget(plan: AppPlan, failure: ClassifiedFailure) {
  // Character class MUST include [ ] — a dynamic route's real file path
  // (app/courses/[id]/page.tsx) contains brackets, and without them here the
  // regex silently matches only the suffix after the last bracket ("/page.tsx"),
  // a meaningless, ambiguous target. Confirmed live: a breadcrumbs failure
  // targeting exactly this kind of path caused the repair prompt to ask the
  // model to fix "/page.tsx", so its (correct) response referencing the real
  // path never matched, and repair stalled at "no progress" every attempt.
  const pathMatch = failure.detail.match(/([\w@./[\]-]+\.(?:tsx?|jsx?))\s*$/);
  const targetPath = pathMatch ? pathMatch[1] : null;
  const page = targetPath ? plan.pages.find(p => pathsMatch(targetPath, p.filePath)) : undefined;
  const api = targetPath ? plan.apiRoutes.find(r => pathsMatch(targetPath, r.filePath)) : undefined;
  const purpose = page?.purpose ?? api?.purpose ?? '';
  const routeLabel = page ? `${page.route} — ${page.title}` : api ? `${api.route} (${api.methods.join('/')})` : '';
  return { targetPath, purpose, routeLabel };
}

/**
 * If a failure carries a quoted "forbidden phrase found" (see verifier.ts's
 * placeholder detection), pull it out and return a prominent, explicit
 * instruction line for the repair prompt. Without this, a retry only sees the
 * generic "don't use placeholders" rule again and can regenerate content that
 * trips the exact same detector a second time — quoting the literal offending
 * text gives the model something concrete to avoid.
 */
function forbiddenPhraseHint(detail: string): string {
  const m = detail.match(/forbidden phrase found: "([^"]+)"/);
  return m ? `- Your PREVIOUS content for this file contained this exact forbidden phrase — do NOT reuse it or anything similar: "${m[1]}"\n` : '';
}

// Batched calls cap at this many failures per Bedrock request — keeps each
// response a manageable size (same truncation risk as any large generation)
// while still cutting the number of round-trips dramatically.
const BATCH_CHUNK_SIZE = 8;

// ── Default (production) wiring — lazy, imported by nobody else, not on /api/chat ──
// Provides a model-driven applyFix and a Verifier-backed verify. Tests inject fakes
// instead and never call this.
export async function defaultRepairerDeps(opts: {
  readProjectFiles: (projectPath: string) => Promise<{ path: string; content: string }[]>;
  probe?: (req: { method?: string; path: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; ms: number; ok: boolean; error?: string }>;
  previewUrl?: string | null;
  /**
   * Called at VERIFY TIME (not construction time), so repair's own internal
   * re-verify loop automatically becomes runtime-aware the moment a preview
   * actually starts — without repair() itself needing to know anything about
   * previewUrl. This is the fix for repairStatus/verifyStatus disagreeing:
   * before this, repair's internal re-verify was always static-only, so
   * during the runtime-repair cycle it structurally could not see whether a
   * RUNTIME-only failure (auth workflow/security checks) was actually fixed
   * — it just reported "resolved" because its own blind view never saw the
   * failure to begin with. Confirmed live (Car Rental Marketplace):
   * repairStatus=passed while the orchestrator's own accurate runtime
   * re-verify still found 1 real failure. Static `probe`/`previewUrl` above
   * are kept for callers that already know their previewUrl up front; this
   * getter takes priority when both are supplied, since it reflects the
   * CURRENT state rather than a value frozen at construction time.
   */
  getPreviewUrl?: () => string | null;
}): Promise<RepairerDeps> {
  return {
    verify: async (plan, projectPath, signal) => {
      const { verifyApp } = await import('./verifier');
      const previewUrl = opts.getPreviewUrl?.() ?? opts.previewUrl ?? null;
      if (!previewUrl) {
        return verifyApp(plan, projectPath, { readProjectFiles: opts.readProjectFiles, probe: opts.probe, previewUrl: opts.previewUrl }, signal);
      }
      const { makeHttpProbe } = await import('./http-probe');
      return verifyApp(plan, projectPath, { readProjectFiles: opts.readProjectFiles, probe: makeHttpProbe(previewUrl), previewUrl }, signal);
    },
    applyFix: async (plan, failure, projectPath, signal) => {
      if (!signal?.aborted) {
        const fast = await tryFastPathFix(plan, failure, projectPath, opts);
        if (fast) return fast;
      }

      // Targeted, single-failure fix via the model. Regenerates ONLY the flagged
      // route/file with REAL, functional content — never the whole project, never
      // an unrelated file.
      const { buildWithAI } = await import('@/services/bedrock');
      const { parseEditFormat, applyEditsToProject } = await import('@/services/file-editor');

      const { targetPath, purpose, routeLabel } = describeTarget(plan, failure);
      const files = await opts.readProjectFiles(projectPath);
      const current = targetPath
        ? files.find(f => pathsMatch(f.path, targetPath))
        : undefined;
      const inventory = files.filter(f => /^(?:src\/)?(components|lib|app\/api)\//.test(f.path)).map(f => f.path).sort();

      const system =
        `You are repairing ONE file in a ${plan.intent.appType} web app called "${plan.displayName}".\n` +
        `Return the COMPLETE corrected file and NOTHING else, in EXACTLY this format:\n` +
        `[EDIT_START]\n[FILE: ${targetPath ?? 'path/to/file'}]\n<full file content>\n[EDIT_END]\n` +
        `HARD RULES:\n` +
        `- Output real, production-quality, fully functional content for THIS app's domain.\n` +
        `- NEVER emit placeholders ("Welcome to the X page", "coming soon", empty scaffolds).\n` +
        forbiddenPhraseHint(failure.detail) +
        `- Complete every statement, import, and JSX tag — the file must compile.\n` +
        `- Only import modules that exist in the provided inventory.\n` +
        `- Edit ONLY ${targetPath ?? 'the flagged file'} — do not touch any other file.`;

      const prompt = [
        `App: ${plan.displayName} — ${plan.description}`,
        routeLabel ? `Route being fixed: ${routeLabel}` : '',
        purpose ? `What this route must do: ${purpose}` : '',
        `Problem to fix (${failure.area}): ${failure.detail}`,
        `Modules you may import:\n${inventory.join('\n') || '(none)'}`,
        current ? `Current broken/placeholder content:\n${current.content.slice(0, 4000)}` : `The file ${targetPath ?? ''} is MISSING — create it complete.`,
        `Now output the full replacement for ${targetPath ?? 'the affected file'}.`,
      ].filter(Boolean).join('\n\n');

      const raw = await buildWithAI(prompt, system, 'SONNET', signal);
      const edits = parseEditFormat(raw);
      if (edits.length === 0) return { changedFiles: [] };

      // Route-scope guard: apply ONLY the flagged file, never fan out to others.
      const scoped = targetPath ? edits.filter(e => pathsMatch(e.path, targetPath)) : edits;
      // Only fall back to "whatever the model returned" when we had NO target to
      // check against — if we DO know the target and nothing matches it, don't
      // guess: applying an edit at some other path would silently write to the
      // wrong file while leaving the real target still missing (this is exactly
      // how the vendor/[id] page repair stall happened).
      const toApply = scoped.length > 0 ? scoped : (targetPath ? [] : edits.slice(0, 1));
      if (toApply.length === 0) return { changedFiles: [] };
      await applyEditsToProject(projectPath, toApply);
      return { changedFiles: toApply.map(e => e.path) };
    },
    applyFixBatch: async (plan, failures, projectPath, signal) => {
      const changedFiles: string[] = [];
      const needsModel: ClassifiedFailure[] = [];

      // 1. Free fixes first (dead links, standard CRUD routes, auth contract) —
      // instant, no Bedrock. Auth failures (signup/login/protected-route) can
      // all appear together in one iteration but the fix rewrites the SAME
      // fixed set of files regardless of which one triggered it — apply it
      // once per batch, not once per matching failure.
      let authFastPathApplied = false;
      const isAuthFailure = (d: string) => /^(Workflow failed: User (signup|login)|Workflow failed: Protected route blocks anonymous|Security failed: Protected page requires auth)$/.test(d);
      for (const failure of failures) {
        if (signal?.aborted) return { changedFiles };
        if (isAuthFailure(failure.detail) && authFastPathApplied) continue;
        const fast = await tryFastPathFix(plan, failure, projectPath, opts);
        if (fast) {
          changedFiles.push(...fast.changedFiles);
          if (isAuthFailure(failure.detail)) authFastPathApplied = true;
        } else {
          needsModel.push(failure);
        }
      }
      if (needsModel.length === 0 || signal?.aborted) return { changedFiles };

      // 2. Everything left needs creative content — batch into as few Bedrock
      // calls as possible (chunked so no single response has to carry too much).
      const { buildWithAI } = await import('@/services/bedrock');
      const { parseEditFormat, applyEditsToProject } = await import('@/services/file-editor');
      const files = await opts.readProjectFiles(projectPath);
      const inventory = files.filter(f => /^(?:src\/)?(components|lib|app\/api)\//.test(f.path)).map(f => f.path).sort();

      for (let i = 0; i < needsModel.length; i += BATCH_CHUNK_SIZE) {
        if (signal?.aborted) return { changedFiles };
        const chunk = needsModel.slice(i, i + BATCH_CHUNK_SIZE);
        const targets = chunk.map(f => describeTarget(plan, f));
        const targetPaths = new Set(targets.map(t => t.targetPath).filter((p): p is string => !!p));

        const system =
          `You are repairing MULTIPLE files in a ${plan.intent.appType} web app called "${plan.displayName}".\n` +
          `Return the COMPLETE corrected content for EVERY file listed below, ALL in EXACTLY this format\n` +
          `(one [FILE: path] block per file, no other text):\n` +
          `[EDIT_START]\n[FILE: path/to/file1]\n<full content>\n[FILE: path/to/file2]\n<full content>\n[EDIT_END]\n` +
          `HARD RULES:\n` +
          `- Output real, production-quality, fully functional content for THIS app's domain.\n` +
          `- NEVER emit placeholders ("Welcome to the X page", "coming soon", empty scaffolds).\n` +
          `- Complete every statement, import, and JSX tag — every file must compile.\n` +
          `- Only import modules that exist in the provided inventory.\n` +
          `- Edit ONLY the files listed below — do not touch any other file.\n` +
          `- Use the EXACT full path given for each file in its [FILE: path] block — the\n` +
          `  complete path including every directory segment, e.g. "app/vendor/[id]/page.tsx",\n` +
          `  never just the filename like "page.tsx".`;

        const problems = chunk.map((failure, idx) => {
          const { targetPath, purpose, routeLabel } = targets[idx];
          const current = targetPath ? files.find(f => pathsMatch(f.path, targetPath)) : undefined;
          const phraseHint = forbiddenPhraseHint(failure.detail);
          return [
            `${idx + 1}. File: ${targetPath ?? '(unknown)'}`,
            routeLabel ? `   Route: ${routeLabel}` : '',
            purpose ? `   Purpose: ${purpose}` : '',
            `   Problem (${failure.area}): ${failure.detail}`,
            phraseHint ? `   ${phraseHint.trim()}` : '',
            current ? `   Current content:\n${current.content.slice(0, 2000)}` : `   File is MISSING — create it complete.`,
          ].filter(Boolean).join('\n');
        }).join('\n\n');

        const prompt = [
          `App: ${plan.displayName} — ${plan.description}`,
          `Fix these ${chunk.length} file(s):`,
          problems,
          `Modules you may import:\n${inventory.join('\n') || '(none)'}`,
          `Now output the complete corrected/created content for EACH of the ${chunk.length} files above.`,
        ].join('\n\n');

        try {
          const raw = await buildWithAI(prompt, system, 'SONNET', signal);
          const edits = parseEditFormat(raw);
          // Safety filter: only accept edits matching one of the requested targets —
          // batching must not open the door to unrequested fan-out edits. Uses
          // pathsMatch (last-2-segments overlap), not a bare endsWith/startsWith
          // suffix check — a loose check let a model response named plain
          // "page.tsx" pass as satisfying "app/vendor/[id]/page.tsx", writing to
          // the wrong location while the real target stayed missing forever.
          const scoped = edits.filter(e => targetPaths.size === 0 || [...targetPaths].some(t => pathsMatch(e.path, t)));
          if (scoped.length > 0) {
            await applyEditsToProject(projectPath, scoped);
            changedFiles.push(...scoped.map(e => e.path));
          }
          const satisfied = new Set(scoped.flatMap(e => [...targetPaths].filter(t => pathsMatch(e.path, t))));
          const unsatisfied = [...targetPaths].filter(t => !satisfied.has(t));
          if (unsatisfied.length > 0) {
            console.log(`[repairer][batch] model response did not include a usable fix for: ${unsatisfied.join(', ')} (returned paths: ${edits.map(e => e.path).join(', ') || '(none)'})`);
          }
        } catch (e) {
          if (signal?.aborted) return { changedFiles }; // preserve fixes already applied before cancellation
          // Non-fatal: this chunk failed, but don't lose changedFiles from earlier
          // chunks or the free fast-path fixes already applied above.
          console.log(`[repairer][batch] chunk of ${chunk.length} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return { changedFiles };
    },
    maxAttempts: 5,
  };
}
