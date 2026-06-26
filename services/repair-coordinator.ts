/**
 * Repair Coordinator — Phase 3 / Phase 7 foundation
 *
 * Single entry point for all repair work. Replaces the pattern of calling
 * signal-collector, project-map, repair-planner, and root-cause-engine
 * separately in multiple places.
 *
 * Call flow:
 *   coordinateRepair(projectPath, errorText, port?)
 *     ├─ 1. Collect signals (TypeScript, build, route conflicts, packages, env)
 *     ├─ 2. Get project map (import graph, file layers, routes, auth, db)
 *     ├─ 3. Build repair plan (shared upstream, deterministic rules, isolated errors)
 *     ├─ 4. Runtime investigation (live endpoint probes, env check) if port given
 *     └─ 5. Return merged, priority-ordered repair plan with full context
 *
 * The builder uses this for BOTH the "regression detected" path and the
 * "user reported an error" (isDebugRequest) path — same pipeline, same quality.
 *
 * Engineering memory auto-apply:
 *   When a BUILTIN_PATTERN matches with confidence 'certain', the coordinator
 *   returns `autoApplicable: true` and `deterministicTransformId` so the builder
 *   can call `deterministic-repair` directly without ever touching the AI.
 */

import type { SignalCollection } from './signal-collector';
import type { ProjectMap } from './project-map';
import type { RepairPlan, RepairStep } from './repair-planner';
import type { RootCauseReport } from './root-cause-engine';
import type { MemoryMatch } from './engineering-memory';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoordinationResult {
  /** Signals collected (TypeScript errors, route conflicts, package issues, etc.) */
  signals: SignalCollection | null;
  /** Full project structure map */
  projectMap: ProjectMap | null;
  /** Ordered repair plan with root cause identified */
  repairPlan: RepairPlan | null;
  /** Runtime investigation report (only when port provided) */
  runtimeReport: RootCauseReport | null;
  /** Best-matching engineering memory pattern */
  memoryMatch: MemoryMatch | null;
  /** When true, caller should apply deterministicTransformId without calling AI */
  autoApplicable: boolean;
  /** The transform ID to pass to deterministic-repair when autoApplicable is true */
  deterministicTransformId: string | null;
  /** Human-readable summary for UI */
  summary: string;
  /** User-facing message (no technical jargon) */
  userMessage: string;
  /** Debug-mode message (full technical detail) */
  debugMessage: string;
  /** Total steps in repair plan */
  stepCount: number;
  /** Ordered steps (root causes first) */
  orderedSteps: RepairStep[];
  /** True if the coordinator identified a shared dependency as the root cause */
  hasSharedUpstream: boolean;
  /** The shared upstream file (if identified) */
  sharedUpstreamFile: string | null;
}

// ─── Main coordinator function ────────────────────────────────────────────────

export async function coordinateRepair(
  projectPath: string,
  errorText: string,
  port?: number,
): Promise<CoordinationResult> {
  let signals: SignalCollection | null = null;
  let projectMap: ProjectMap | null = null;
  let repairPlan: RepairPlan | null = null;
  let runtimeReport: RootCauseReport | null = null;
  let memoryMatch: MemoryMatch | null = null;

  // Step 1: Engineering memory — check before doing anything else.
  // If we have a 'certain' match, we can skip signals + map + plan entirely.
  try {
    const { findMatchingRepair } = await import('./engineering-memory');
    memoryMatch = await findMatchingRepair(errorText, []);
  } catch { /* non-critical */ }

  // 'certain' is not a native MemoryMatch confidence — map 'high' to auto-apply when directTransform present
  const memCertain = memoryMatch?.confidence === 'high' && !!memoryMatch?.pattern?.directTransform;
  const memHigh    = memoryMatch?.confidence === 'high' && !memoryMatch?.pattern?.directTransform;

  // Step 2: Collect all error signals (fast, parallel, ~3s)
  try {
    const { collectAllSignals } = await import('./signal-collector');
    signals = await collectAllSignals(projectPath, {
      existingErrorText: errorText,
      runBuildCheck: false,   // L2 build check is too slow for coordination phase
      skipRuntimeLog: false,
    });
  } catch { /* continue without signals */ }

  // Step 3: Get (or build) project map — uses 5-minute cache
  try {
    const { getProjectMap } = await import('./project-map');
    projectMap = await getProjectMap(projectPath);
  } catch { /* continue without map */ }

  // Step 4: Build repair plan from signals + map
  if (signals && projectMap) {
    try {
      const { buildRepairPlan } = await import('./repair-planner');
      repairPlan = buildRepairPlan(signals, projectMap);
    } catch { /* continue without plan */ }
  }

  // Step 5: Runtime investigation when a port is provided (optional, adds ~5s)
  if (port) {
    try {
      const { investigateRootCause } = await import('./root-cause-engine');
      runtimeReport = await investigateRootCause({ projectPath, port });
    } catch { /* non-critical */ }
  }

  // ─── Determine if auto-apply is possible ────────────────────────────────────

  // Auto-apply: memory 'high' match with a directTransform means we can skip AI
  const deterministicTransformId = memCertain && memoryMatch?.pattern?.directTransform
    ? memoryMatch.pattern.directTransform
    : null;
  const autoApplicable = !!deterministicTransformId;

  // ─── Identify shared upstream ────────────────────────────────────────────────

  const sharedUpstreamStep = repairPlan?.steps?.find(s => {
    const hyp = repairPlan?.hypotheses?.find(h => h.rule === 'shared-upstream');
    return hyp && s.targetFile === hyp.rootCauseFile;
  });
  const hasSharedUpstream = !!sharedUpstreamStep;
  const sharedUpstreamFile = hasSharedUpstream ? sharedUpstreamStep!.targetFile : null;

  // ─── Merge steps: deterministic transforms first, then repair plan ───────────

  const orderedSteps: RepairStep[] = repairPlan?.steps?.slice(0, 8) ?? [];

  // ─── Generate messages ────────────────────────────────────────────────────────

  const planSummary = repairPlan?.summary ?? '';
  const memorySummary = memoryMatch ? `Known pattern: ${memoryMatch.pattern.rootCause}` : '';

  const summary = autoApplicable
    ? `Auto-fix available: ${memorySummary}`
    : hasSharedUpstream
    ? `Root cause: shared dependency ${sharedUpstreamFile} — fix propagates to all downstream files`
    : repairPlan?.hasRootCause
    ? planSummary
    : memorySummary || signals?.summary || 'No specific root cause identified';

  const userMessage = autoApplicable
    ? 'Applying known fix…'
    : hasSharedUpstream
    ? 'Fixing shared dependency…'
    : repairPlan?.hasRootCause
    ? 'Root cause identified — repairing…'
    : 'Investigating and repairing…';

  const debugParts: string[] = [];
  if (signals) debugParts.push(`Signals: ${signals.summary}`);
  if (memoryMatch) debugParts.push(`Memory match: ${memoryMatch.pattern.rootCause} (${memoryMatch.confidence})`);
  if (autoApplicable) debugParts.push(`Auto-apply transform: ${deterministicTransformId}`);
  if (sharedUpstreamFile) debugParts.push(`Shared upstream: ${sharedUpstreamFile}`);
  if (planSummary) debugParts.push(`Plan: ${planSummary}`);
  if (runtimeReport) debugParts.push(`Runtime: ${runtimeReport.primaryLayer} layer — ${runtimeReport.findings.slice(0,2).map(f => f.detail).join('; ')}`);
  const debugMessage = debugParts.join('\n') || 'Coordination complete — no specific diagnosis';

  return {
    signals,
    projectMap,
    repairPlan,
    runtimeReport,
    memoryMatch,
    autoApplicable,
    deterministicTransformId,
    summary,
    userMessage,
    debugMessage,
    stepCount: orderedSteps.length,
    orderedSteps,
    hasSharedUpstream,
    sharedUpstreamFile,
  };
}

// ─── Quick coordination (no runtime probe, fast path) ────────────────────────

export async function quickCoordinate(
  projectPath: string,
  errorText: string,
): Promise<Pick<CoordinationResult, 'memoryMatch' | 'autoApplicable' | 'deterministicTransformId' | 'summary' | 'userMessage' | 'debugMessage'>> {
  let memoryMatch: MemoryMatch | null = null;
  try {
    const { findMatchingRepair } = await import('./engineering-memory');
    memoryMatch = await findMatchingRepair(errorText, []);
  } catch { /* non-critical */ }

  // High confidence + directTransform = can skip AI entirely
  const deterministicTransformId = memoryMatch?.confidence === 'high' && memoryMatch.pattern?.directTransform
    ? memoryMatch.pattern.directTransform
    : null;
  const autoApplicable = !!deterministicTransformId;

  return {
    memoryMatch,
    autoApplicable,
    deterministicTransformId,
    summary: memoryMatch ? `Known pattern: ${memoryMatch.pattern.rootCause}` : 'No memory match',
    userMessage: autoApplicable ? 'Applying known fix…' : 'Investigating…',
    debugMessage: memoryMatch ? `Memory: ${memoryMatch.pattern.rootCause} (${memoryMatch.confidence})` : 'No memory match',
  };
}
