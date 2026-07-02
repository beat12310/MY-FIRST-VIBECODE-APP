/**
 * DWOMOH VIBE CODE — Learner Engine (Step 6).
 *
 * Persists what worked so future builds get better:
 *   - successful repair patterns (failure → fix), learned ONLY from internal,
 *     repairable failures that led to a VERIFIED-passed build;
 *   - architecture decisions (app type → capabilities/providers/UI), learned ONLY
 *     from verified-passed builds;
 *   - user edit preferences, recorded from successfully applied edits.
 *
 * Hard rules:
 *   - NEVER learn from a build that is not verify.passed === true.
 *   - NEVER learn from external-provider issues (Cognito/Bedrock/Paystack/…).
 *   - Returns facts only (LearnResult); never marks anything "complete".
 *
 * Standalone: imports only the type contract. The store is injected, so the logic
 * is fully unit-testable; production wiring (file/DynamoDB-backed) is lazy and
 * imported by nobody else. Not wired into /api/chat.
 */
import type { AppPlan, ClassifiedFailure, RepairResult, VerifyResult } from './types';

// ── Learned records ───────────────────────────────────────────────────────────
export interface RepairPattern {
  id: string;
  appType: string;
  failureArea: ClassifiedFailure['area'];
  failureSignature: string;   // generalized (paths/ids normalized) so it matches future cases
  changedFiles: string[];
  createdAt: string;
}

export interface ArchitectureDecision {
  id: string;
  appType: string;
  capabilities: string[];
  providers: { capability: string; provider: string; version: string }[];
  uiStylePreset: string;
  pageRoutes: string[];
  createdAt: string;
}

export interface EditPreference {
  id: string;
  userId?: string;
  key: string;     // e.g. 'ui.style', 'palette.dark', 'tone'
  value: string;
  createdAt: string;
}

export interface LearnerStore {
  saveRepairPattern(p: RepairPattern): Promise<void>;
  saveArchitectureDecision(d: ArchitectureDecision): Promise<void>;
  saveEditPreference(e: EditPreference): Promise<void>;
  getRepairPatterns(): Promise<RepairPattern[]>;
  getArchitectureDecisions(): Promise<ArchitectureDecision[]>;
  getEditPreferences(userId?: string): Promise<EditPreference[]>;
}

export interface LearnResult {
  learned: boolean;
  reason?: string;
  storedPatterns: number;
  storedDecisions: number;
  storedPreferences: number;
}

export interface LearnInput {
  plan: AppPlan;
  verify: VerifyResult;                 // must be passed === true to learn anything
  repair?: RepairResult;
  /** The internal failures that were actually fixed (provided by the orchestrator). */
  repairedFailures?: ClassifiedFailure[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const rid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Normalize a failure detail so patterns generalize (strip concrete paths/ids/numbers). */
export function failureSignature(detail: string): string {
  return detail
    .replace(/app\/[\w/\-.[\]]+/g, '<file>')
    .replace(/\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/gi, '<route>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Learn from a build/repair ─────────────────────────────────────────────────
export async function learnFromBuild(input: LearnInput, store: LearnerStore): Promise<LearnResult> {
  const base: LearnResult = { learned: false, storedPatterns: 0, storedDecisions: 0, storedPreferences: 0 };

  // RULE: only learn from a VERIFIED successful build.
  if (!input.verify || input.verify.passed !== true) {
    return { ...base, reason: 'build is not verify.passed === true — nothing learned' };
  }

  // Architecture decision (what worked for this app type).
  const decision: ArchitectureDecision = {
    id: rid('arch'),
    appType: input.plan.intent.appType,
    capabilities: input.plan.capabilities,
    providers: input.plan.resolvedCapabilities.map(rc => ({ capability: rc.capability, provider: rc.provider, version: rc.version })),
    uiStylePreset: input.plan.uiStyle.preset,
    pageRoutes: input.plan.pages.map(p => p.route),
    createdAt: ts(),
  };
  await store.saveArchitectureDecision(decision);
  let storedDecisions = 1;

  // Repair patterns — ONLY internal + repairable failures that were fixed.
  let storedPatterns = 0;
  const fixed = (input.repairedFailures ?? []).filter(fa => fa.origin === 'internal' && fa.repairable);
  if (input.repair?.resolved && fixed.length > 0) {
    for (const fa of fixed) {
      const pattern: RepairPattern = {
        id: rid('fix'),
        appType: input.plan.intent.appType,
        failureArea: fa.area,
        failureSignature: failureSignature(fa.detail),
        changedFiles: input.repair.changedFiles,
        createdAt: ts(),
      };
      await store.saveRepairPattern(pattern);
      storedPatterns++;
    }
  }
  // External issues are intentionally never stored — they are not our patterns.

  return { learned: true, storedPatterns, storedDecisions, storedPreferences: 0 };
}

/** Record a user edit preference from a SUCCESSFULLY applied edit (caller asserts success). */
export async function recordEditPreference(pref: { userId?: string; key: string; value: string }, store: LearnerStore): Promise<LearnResult> {
  if (!pref.key || !pref.value) {
    return { learned: false, reason: 'empty preference', storedPatterns: 0, storedDecisions: 0, storedPreferences: 0 };
  }
  await store.saveEditPreference({ id: rid('pref'), userId: pref.userId, key: pref.key, value: pref.value, createdAt: ts() });
  return { learned: true, storedPatterns: 0, storedDecisions: 0, storedPreferences: 1 };
}

/** Read side — surface learned knowledge to reuse on a future plan (Planner/Builder later). */
export async function suggestForPlan(plan: AppPlan, store: LearnerStore): Promise<{
  decisions: ArchitectureDecision[];
  patterns: RepairPattern[];
}> {
  const [decisions, patterns] = await Promise.all([store.getArchitectureDecisions(), store.getRepairPatterns()]);
  const appType = plan.intent.appType;
  return {
    decisions: decisions.filter(d => d.appType === appType),
    patterns: patterns.filter(p => p.appType === appType),
  };
}

// ── In-memory store (default + tests) ─────────────────────────────────────────
export function inMemoryLearnerStore(): LearnerStore {
  const patterns: RepairPattern[] = [];
  const decisions: ArchitectureDecision[] = [];
  const prefs: EditPreference[] = [];
  return {
    saveRepairPattern: async (p) => { patterns.push(p); },
    saveArchitectureDecision: async (d) => { decisions.push(d); },
    saveEditPreference: async (e) => { prefs.push(e); },
    getRepairPatterns: async () => [...patterns],
    getArchitectureDecisions: async () => [...decisions],
    getEditPreferences: async (userId) => prefs.filter(e => !userId || e.userId === userId),
  };
}
