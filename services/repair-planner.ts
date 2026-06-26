/**
 * Repair Planner
 *
 * Given a SignalCollection (all error signals) and a ProjectMap (project structure),
 * identifies the ROOT CAUSE file(s) and generates an ordered repair plan.
 *
 * This is the bridge between "what went wrong" (signals) and "what to fix and in what
 * order" (repair steps). It replaces the current approach of "fix whichever file the
 * error message mentions" with "find the file RESPONSIBLE for the error, then order
 * repairs so root causes are fixed before their dependents."
 *
 * All rules are deterministic. No AI call. Runs in <50ms.
 */

import type { ErrorSignal, SignalCollection } from './signal-collector';
import type { ProjectMap } from './project-map';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RepairAction =
  | 'deterministic'       // known code transform, no AI needed
  | 'targeted-ai'         // AI fix on the root-cause file, with context files
  | 'architecture-ai'     // AI fix with the full dependency subgraph as context
  | 'delete-file'         // remove a duplicate/conflicting file
  | 'install-package'     // npm install a missing package
  | 'create-file'         // create a missing file that other files import
  | 'env-config';         // .env.local needs a new entry

export type PlanConfidence = 'certain' | 'high' | 'medium';

export interface RepairStep {
  stepNumber: number;
  title: string;
  targetFile: string;
  action: RepairAction;
  instruction: string;
  contextFiles: string[];     // files the AI should also read for context
  expectedOutcome: string;
  transformId?: string;       // for deterministic action
  packageName?: string;       // for install-package action
  envKey?: string;            // for env-config action
}

export interface RepairHypothesis {
  id: string;
  rule: string;
  rootCauseFile: string;
  confidence: PlanConfidence;
  reason: string;
  affectedFiles: string[];
  steps: RepairStep[];
  signalIds: string[];
  priority: number;           // lower number = fix first
}

export interface RepairPlan {
  hypotheses: RepairHypothesis[];
  steps: RepairStep[];        // flattened, deduplicated, ordered
  summary: string;            // user-facing one-liner
  debugDetail: string;        // technical detail for debug mode
  hasRootCause: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
const hid = () => `h${++_counter}`;

function getDeps(file: string, map: ProjectMap): string[] {
  return map.importGraph[file] ?? [];
}

function getImporters(file: string, map: ProjectMap): string[] {
  return map.exportGraph[file] ?? [];
}

/**
 * Among a set of broken files, find the common upstream dependency that
 * the majority of them import. That upstream file is likely the root cause.
 */
function findSharedUpstream(broken: string[], map: ProjectMap): string | null {
  if (broken.length < 2) return null;
  const counts = new Map<string, number>();
  for (const f of broken) {
    for (const dep of getDeps(f, map)) {
      counts.set(dep, (counts.get(dep) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [f, n] of counts) {
    if (n > bestN && n >= Math.ceil(broken.length / 2)) { best = f; bestN = n; }
  }
  return best;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

function ruleRouteConflict(signals: ErrorSignal[], map: ProjectMap): RepairHypothesis | null {
  const conflicts = signals.filter(s => s.source === 'route-conflict');
  if (conflicts.length === 0) return null;

  const steps: RepairStep[] = [];
  let n = 1;

  for (const conflict of conflicts) {
    const fileMatch = /(\S+?\.(?:tsx|ts|jsx|js))\s+and\s+(\S+?\.(?:tsx|ts|jsx|js))/.exec(conflict.message);
    if (!fileMatch) continue;

    const [, fileA, fileB] = fileMatch;
    const rgFile = /\([^)]+\)/.test(fileA) ? fileA : fileB;
    const bareFile = /\([^)]+\)/.test(fileA) ? fileB : fileA;

    const groupMatch = /app\/(\([^)]+\))\//.exec(rgFile);
    const groupLayoutPath = groupMatch ? `app/${groupMatch[1]}/layout.tsx` : null;
    const groupHasLayout = groupLayoutPath ? map.files.some(f => f.path === groupLayoutPath) : false;

    const toDelete = groupHasLayout ? bareFile : rgFile;
    const toKeep = groupHasLayout ? rgFile : bareFile;

    steps.push({
      stepNumber: n++,
      title: `Delete duplicate route: ${toDelete}`,
      targetFile: toDelete,
      action: 'delete-file',
      instruction: `Delete ${toDelete} — it conflicts with ${toKeep} (both resolve to the same URL). Keep ${toKeep}${groupHasLayout ? ' because its route group has a shared layout.' : '.'}`,
      contextFiles: [toKeep],
      expectedOutcome: 'No two page files resolve to the same URL',
      transformId: 'duplicate-route-conflict',
    });
  }

  if (steps.length === 0) return null;

  return {
    id: hid(), rule: 'route-conflict',
    rootCauseFile: steps[0].targetFile,
    confidence: 'certain',
    reason: 'Two page files resolve to the same URL path. Next.js build fails with "two parallel pages."',
    affectedFiles: steps.map(s => s.targetFile),
    steps, signalIds: conflicts.map(s => s.id), priority: 1,
  };
}

function ruleMissingPackage(signals: ErrorSignal[]): RepairHypothesis | null {
  const pkgs = signals.filter(s => s.source === 'missing-package');
  if (pkgs.length === 0) return null;

  return {
    id: hid(), rule: 'missing-package',
    rootCauseFile: 'package.json', confidence: 'certain',
    reason: `${pkgs.length} npm package(s) are imported in source but not installed.`,
    affectedFiles: ['package.json'],
    steps: pkgs.map((s, i) => ({
      stepNumber: i + 1,
      title: `Install ${s.code}`,
      targetFile: 'package.json',
      action: 'install-package',
      instruction: `npm install ${s.code} --legacy-peer-deps`,
      contextFiles: [], expectedOutcome: `${s.code} available in node_modules`,
      packageName: s.code,
    })),
    signalIds: pkgs.map(s => s.id), priority: 1,
  };
}

function ruleMissingEnvVar(signals: ErrorSignal[]): RepairHypothesis | null {
  const envs = signals.filter(s => s.source === 'missing-env');
  if (envs.length === 0) return null;

  return {
    id: hid(), rule: 'missing-env',
    rootCauseFile: '.env.local', confidence: 'high',
    reason: `${envs.length} env var(s) referenced in code are absent from .env.local`,
    affectedFiles: ['.env.local'],
    steps: envs.map((s, i) => ({
      stepNumber: i + 1,
      title: `Add ${s.code} to .env.local`,
      targetFile: '.env.local',
      action: 'env-config',
      instruction: `Add ${s.code}=<value> to .env.local. Value depends on the service being configured.`,
      contextFiles: [], expectedOutcome: `${s.code} available at runtime`,
      envKey: s.code,
    })),
    signalIds: envs.map(s => s.id), priority: 2,
  };
}

function ruleDbRawInstance(signals: ErrorSignal[]): RepairHypothesis | null {
  const hits = signals.filter(s =>
    s.source === 'typescript' &&
    /Property 'get' does not exist on type.*Database|Property 'all' does not exist on type/i.test(s.message)
  );
  if (hits.length === 0) return null;

  return {
    id: hid(), rule: 'db-raw-instance',
    rootCauseFile: 'lib/managed/db.ts', confidence: 'certain',
    reason: 'Database exported as raw better-sqlite3 instance instead of managed wrapper with .get()/.all()/.run()',
    affectedFiles: [...new Set(hits.map(s => s.file).filter(Boolean) as string[])],
    steps: [{
      stepNumber: 1, title: 'Fix lib/managed/db.ts — replace raw instance with managed wrapper',
      targetFile: 'lib/managed/db.ts', action: 'deterministic',
      instruction: 'Replace raw Database export with managed wrapper: export const db = { get, all, run }',
      contextFiles: [], expectedOutcome: 'db.get(), db.all(), db.run() are typed correctly',
      transformId: 'db-get-raw-instance',
    }],
    signalIds: hits.map(s => s.id), priority: 1,
  };
}

function ruleAuthMissingAwait(signals: ErrorSignal[], map: ProjectMap): RepairHypothesis | null {
  const hits = signals.filter(s =>
    s.source === 'typescript' &&
    /does not exist on type.*Promise|Property.*sub.*does not exist|userId.*does not exist.*Promise/i.test(s.message)
  );
  if (hits.length === 0) return null;

  const authFile = map.authFiles[0] ?? 'lib/auth.ts';
  const affected = [...new Set(hits.map(s => s.file).filter(Boolean) as string[])];

  return {
    id: hid(), rule: 'auth-missing-await',
    rootCauseFile: authFile, confidence: 'high',
    reason: 'Auth function called without await — accessing properties on Promise<Token> instead of Token',
    affectedFiles: affected,
    steps: [{
      stepNumber: 1, title: `Add missing await in ${authFile}`,
      targetFile: authFile, action: 'deterministic',
      instruction: 'Change: const auth = getAuthUser(req) → const auth = await getAuthUser(req)',
      contextFiles: affected.slice(0, 3),
      expectedOutcome: 'Auth function returns resolved Token, not Promise<Token>',
      transformId: 'auth-missing-await',
    }],
    signalIds: hits.map(s => s.id), priority: 2,
  };
}

function ruleMissingUseClient(signals: ErrorSignal[]): RepairHypothesis | null {
  const hits = signals.filter(s =>
    s.source === 'typescript' &&
    /useState.*not.*function|useEffect.*not.*function|hooks.*client|importing.*useState/i.test(s.message)
  );
  if (hits.length === 0) return null;

  const files = [...new Set(hits.map(s => s.file).filter(Boolean) as string[])];

  return {
    id: hid(), rule: 'missing-use-client',
    rootCauseFile: files[0], confidence: 'high',
    reason: 'React hook used in a Server Component — "use client" directive missing at top of file',
    affectedFiles: files,
    steps: files.map((f, i) => ({
      stepNumber: i + 1,
      title: `Add "use client" to ${f}`,
      targetFile: f, action: 'deterministic',
      instruction: 'Add "use client"; as the FIRST line — before any imports',
      contextFiles: [], expectedOutcome: 'File treated as Client Component, hooks allowed',
      transformId: 'missing-use-client',
    })),
    signalIds: hits.map(s => s.id), priority: 2,
  };
}

// High-impact layer files: fixing these resolves many downstream errors.
// Lower threshold (2 instead of 3) because a broken db.ts or auth.ts
// cascades to every API route.
const HIGH_IMPACT_LAYER_PATTERNS = [
  /^lib\/(?:managed\/)?(?:db|database|prisma|supabase|storage)/i,
  /^lib\/(?:managed\/)?(?:auth|cognito|session|jwt)/i,
  /^lib\/(?:managed\/)?(?:email|mailer|ses|sendgrid)/i,
  /^services\/(?:db|auth|email|storage)/i,
];

function isHighImpactFile(filePath: string): boolean {
  return HIGH_IMPACT_LAYER_PATTERNS.some(re => re.test(filePath));
}

function ruleSharedUpstream(signals: ErrorSignal[], map: ProjectMap): RepairHypothesis | null {
  const tsErrors = signals.filter(s => s.source === 'typescript' && s.severity === 'error');
  if (tsErrors.length < 2) return null;

  // Group by normalised error message
  const byPattern = new Map<string, ErrorSignal[]>();
  for (const s of tsErrors) {
    const key = s.message.replace(/['"`][^'"`]+['"`]/g, 'X').replace(/\d+/g, 'N').slice(0, 50);
    const g = byPattern.get(key) ?? [];
    g.push(s);
    byPattern.set(key, g);
  }

  // Also add an "import-error" group: many files failing to import the same symbol
  const importErrors = signals.filter(s =>
    s.source === 'import-error' ||
    (s.source === 'typescript' && /Module.*not found|Cannot find module|has no exported member/i.test(s.message))
  );
  if (importErrors.length >= 2) {
    const importKey = '__import_errors__';
    byPattern.set(importKey, importErrors);
  }

  let bestHypothesis: RepairHypothesis | null = null;
  let bestPriority = 99;

  for (const group of byPattern.values()) {
    const broken = [...new Set(group.map(s => s.file).filter(Boolean) as string[])];
    if (broken.length < 2) continue;

    const upstream = findSharedUpstream(broken, map);
    if (!upstream) continue;

    const isHighImpact = isHighImpactFile(upstream);
    const minGroupSize = isHighImpact ? 2 : 3;

    if (group.length < minGroupSize) continue;

    const importers = getImporters(upstream, map);
    const priority = isHighImpact ? 2 : 3;

    const hyp: RepairHypothesis = {
      id: hid(), rule: 'shared-upstream',
      rootCauseFile: upstream, confidence: isHighImpact ? 'certain' : 'high',
      reason: `Same error in ${broken.length} files that all import ${upstream}${isHighImpact ? ' (core shared dependency — fix this first)' : ''}. Fixing the root resolves all downstream errors.`,
      affectedFiles: broken,
      steps: [{
        stepNumber: 1,
        title: `Fix shared dependency: ${upstream}`,
        targetFile: upstream, action: 'architecture-ai',
        instruction:
          `SHARED DEPENDENCY ROOT CAUSE: This file is imported by ${broken.length} files showing the same error. ` +
          `Do NOT patch the downstream files individually — fix THIS file. ` +
          `Errors: ${group[0].message.slice(0, 120)}. ` +
          `Affected downstream files: ${broken.slice(0, 4).join(', ')}`,
        contextFiles: [...broken.slice(0, 3), ...importers.slice(0, 2)],
        expectedOutcome: 'All downstream files resolve without this error class',
      }],
      signalIds: group.map(s => s.id), priority,
    };

    if (priority < bestPriority) {
      bestPriority = priority;
      bestHypothesis = hyp;
    }
  }

  return bestHypothesis;
}

function ruleIsolatedTsErrors(
  signals: ErrorSignal[],
  coveredIds: Set<string>,
  map: ProjectMap,
): RepairHypothesis | null {
  const uncovered = signals.filter(
    s => s.source === 'typescript' && s.severity === 'error' && !coveredIds.has(s.id)
  );
  if (uncovered.length === 0) return null;

  const files = [...new Set(uncovered.map(s => s.file).filter(Boolean) as string[])];
  if (files.length === 0) return null;

  return {
    id: hid(), rule: 'isolated-ts-errors',
    rootCauseFile: files[0], confidence: 'medium',
    reason: `TypeScript error(s) in ${files.length} file(s) with no identifiable shared upstream cause`,
    affectedFiles: files,
    steps: files.map((f, i) => {
      const fileErrors = uncovered.filter(s => s.file === f);
      return {
        stepNumber: i + 1,
        title: `Fix TypeScript errors in ${f}`,
        targetFile: f, action: 'targeted-ai',
        instruction: `Fix these TypeScript errors:\n${fileErrors.map(e => `• ${e.message}`).join('\n')}`,
        contextFiles: [...getDeps(f, map).slice(0, 2), ...getImporters(f, map).slice(0, 2)],
        expectedOutcome: `${f} compiles without errors`,
      };
    }),
    signalIds: uncovered.map(s => s.id), priority: 5,
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

export function buildRepairPlan(collection: SignalCollection, map: ProjectMap): RepairPlan {
  const { signals } = collection;
  const hypotheses: RepairHypothesis[] = [];

  // Rules in priority order (certain → high → medium)
  const route = ruleRouteConflict(signals, map);
  const pkg   = ruleMissingPackage(signals);
  const db    = ruleDbRawInstance(signals);
  const env   = ruleMissingEnvVar(signals);
  const auth  = ruleAuthMissingAwait(signals, map);
  const uc    = ruleMissingUseClient(signals);
  const up    = ruleSharedUpstream(signals, map);

  for (const h of [route, pkg, db, env, auth, uc, up]) {
    if (h) hypotheses.push(h);
  }

  // Isolated errors: only for signals not covered by other hypotheses
  const coveredIds = new Set(hypotheses.flatMap(h => h.signalIds));
  const isolated = ruleIsolatedTsErrors(signals, coveredIds, map);
  if (isolated) hypotheses.push(isolated);

  hypotheses.sort((a, b) => a.priority - b.priority);

  // Flatten to ordered step list, deduplicate by targetFile
  const seen = new Set<string>();
  const steps: RepairStep[] = [];
  let sn = 1;
  for (const h of hypotheses) {
    for (const step of h.steps) {
      if (seen.has(step.targetFile)) continue;
      seen.add(step.targetFile);
      steps.push({ ...step, stepNumber: sn++ });
    }
  }

  const debugLines: string[] = [];
  for (const h of hypotheses) {
    debugLines.push(`[${h.confidence.toUpperCase()}] ${h.rule}: ${h.rootCauseFile}`);
    debugLines.push(`  → ${h.reason}`);
    if (h.affectedFiles.length > 1) debugLines.push(`  Affects: ${h.affectedFiles.join(', ')}`);
  }

  const summary = hypotheses.length === 0
    ? 'No root cause identified — will apply targeted AI repair'
    : hypotheses.length === 1
      ? hypotheses[0].reason.slice(0, 100)
      : `${hypotheses.length} root cause(s) found — repairing in order`;

  return {
    hypotheses,
    steps,
    summary,
    debugDetail: debugLines.join('\n') || 'No hypotheses generated',
    hasRootCause: hypotheses.length > 0,
  };
}
