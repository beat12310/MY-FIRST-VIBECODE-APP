/**
 * Repair Learner
 *
 * Every successful repair is a learning opportunity for the DWOMOH engine.
 * This service runs AFTER a repair succeeds and:
 *
 *   1. Extracts a reusable pattern from the raw error context
 *   2. Classifies which engine capability this repair belongs to
 *   3. Stores or updates the pattern in engineering memory
 *   4. Promotes to auto-repair (directTransform) when confidence is high
 *   5. Runs verification to confirm the pattern is correctly captured
 *   6. Returns a structured learning result
 *
 * The caller (builder pipeline) uses the result to:
 *   - Show the user which engine capability improved
 *   - Skip AI on future identical errors (auto-repair path)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepairContext {
  /** Raw error text before the repair (TS errors, server logs, build error) */
  errorText: string;
  /** Files that were changed by the repair */
  changedFiles: string[];
  /** The user's original message (for context) */
  userMessage: string;
  /** Model tier that succeeded */
  successfulTier: 'HAIKU' | 'SONNET' | 'STRONGEST';
  /** Absolute path to the project */
  projectPath: string;
  /** Summary of what was fixed (from repair result, optional) */
  fixSummary?: string;
}

export interface LearningResult {
  /** Which engine capability was improved */
  capabilityId: string;
  capabilityName: string;
  /** Short description of the pattern that was stored */
  patternStored: string;
  /** Whether future occurrences can now be auto-repaired without AI */
  isAutoRepair: boolean;
  /** How many times this pattern has now been seen */
  confidence: 'low' | 'medium' | 'high';
  successCount: number;
  /** Whether TypeScript still passes after the repair (verification result) */
  verificationPassed: boolean;
  /** The recommended directTransform ID (if promoted to auto-repair) */
  directTransformId?: string;
  /** User-facing summary of what the engine learned */
  engineImprovement: string;
}

// ─── Pattern extraction (AI-assisted) ────────────────────────────────────────

interface ExtractedPattern {
  errorPattern: string;    // Regex pattern that would match this error
  rootCause: string;       // One-line root cause description
  fixApproach: string;     // How to fix it
  tsErrorsToAvoid: string[]; // TS error codes / strings that should not appear after fix
  targetFiles: string[];   // Typical files involved
  suggestedTransformId?: string; // If deterministic, a transform ID
}

function buildPatternExtractionPrompt(ctx: RepairContext): string {
  const changedSummary = ctx.changedFiles.slice(0, 5).join(', ');
  return `A software repair was completed. Extract a reusable error pattern from this context.

ERROR TEXT BEFORE REPAIR:
${ctx.errorText.slice(0, 1000)}

FILES CHANGED:
${changedSummary}

USER REQUEST:
${ctx.userMessage.slice(0, 200)}

FIX SUMMARY:
${ctx.fixSummary || '(not provided)'}

OUTPUT a JSON object (no markdown, raw JSON only):
{
  "errorPattern": "<a regex string that would match this error in future projects>",
  "rootCause": "<one-line cause, e.g. 'Missing await on getAuthUser()'>",
  "fixApproach": "<step-by-step fix in plain English, max 3 sentences>",
  "tsErrorsToAvoid": ["<TS error code or snippet>"],
  "targetFiles": ["<typical file paths, relative>"],
  "suggestedTransformId": "<kebab-case id if this is a deterministic rename/add-await/type-fix, else null>"
}`;
}

async function extractPattern(
  ctx: RepairContext,
  callAI: (prompt: string, tier: 'HAIKU' | 'SONNET') => Promise<string>,
): Promise<ExtractedPattern | null> {
  if (!ctx.errorText.trim()) return null;

  try {
    const prompt = buildPatternExtractionPrompt(ctx);
    const raw = await callAI(prompt, 'HAIKU');

    // Find the JSON block
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedPattern;

    // Validate minimum fields
    if (!parsed.errorPattern || !parsed.rootCause || !parsed.fixApproach) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Auto-repair promotion ────────────────────────────────────────────────────
// When a pattern is seen ≥ 3 times, we promote it to auto-repair.
// The transform ID encodes what kind of deterministic fix applies.

const DETERMINISTIC_ELIGIBLE_PATTERNS: Record<string, RegExp> = {
  'import-rename':    /has no exported member|is not exported|TS2305|TS2307/i,
  'auth-missing-await': /does not exist on type.*Promise|Property.*sub.*Promise/i,
  'nextjs15-async-params': /RouteHandlerConfig|params.*Promise.*not assignable|does not satisfy.*RouteHandlerConfig/i,
  'missing-use-client': /hooks.*client|useState.*server|useEffect.*server/i,
};

function suggestTransformId(errorText: string, suggestedId?: string | null): string | undefined {
  // If the AI suggested a specific transform, verify it matches a known one
  if (suggestedId && Object.keys(DETERMINISTIC_ELIGIBLE_PATTERNS).includes(suggestedId)) {
    return suggestedId;
  }
  // Otherwise auto-detect from error text
  for (const [id, re] of Object.entries(DETERMINISTIC_ELIGIBLE_PATTERNS)) {
    if (re.test(errorText)) return id;
  }
  return undefined;
}

// ─── Verification ─────────────────────────────────────────────────────────────

async function runVerification(projectPath: string): Promise<boolean> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execP = promisify(exec);
    const { stdout, stderr } = await execP('npx tsc --noEmit 2>&1', {
      cwd: projectPath,
      timeout: 30000,
    });
    return !stdout.trim() && !stderr.trim();
  } catch {
    return false;
  }
}

// ─── Main learning function ───────────────────────────────────────────────────

export async function learnFromRepair(
  ctx: RepairContext,
  callAI: (prompt: string, tier: 'HAIKU' | 'SONNET') => Promise<string>,
): Promise<LearningResult> {
  // Step 1: Classify which engine capability this affects
  const { classifyCapability } = await import('./capability-registry');
  const capMatch = classifyCapability(ctx.errorText, ctx.changedFiles, ctx.userMessage);
  const cap = capMatch?.capability ?? { id: 'build-repair', name: 'Build Repair Engine', improvementDescription: '' };

  // Step 2: Extract pattern from error context (AI-assisted, non-blocking on failure)
  let extracted: ExtractedPattern | null = null;
  try {
    extracted = await extractPattern(ctx, callAI);
  } catch { /* non-critical */ }

  // If extraction failed, build a minimal pattern from what we know
  if (!extracted) {
    const firstLine = ctx.errorText.split('\n')[0]?.slice(0, 120) ?? 'unknown error';
    extracted = {
      errorPattern: firstLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100),
      rootCause: `Repair: ${ctx.changedFiles[0] ?? 'unknown file'} — ${ctx.userMessage.slice(0, 60)}`,
      fixApproach: ctx.fixSummary ?? `Fixed via ${ctx.successfulTier}`,
      tsErrorsToAvoid: [],
      targetFiles: ctx.changedFiles.slice(0, 3),
    };
  }

  // Step 3: Check if this pattern already exists in memory (update vs insert)
  const { findMatchingRepair, saveRepairSuccess } = await import('./engineering-memory');
  let existingMatch = null;
  try {
    existingMatch = await findMatchingRepair(ctx.errorText, []);
  } catch { /* non-critical */ }

  const alreadyKnown = existingMatch !== null && existingMatch.confidence === 'high';

  // Step 4: Determine if this qualifies for auto-repair
  const successCount = (existingMatch?.pattern.successCount ?? 0) + 1;
  const transformId = suggestTransformId(ctx.errorText, extracted.suggestedTransformId);
  const isAutoRepair = successCount >= 3 && !!transformId;
  const confidence: 'low' | 'medium' | 'high' =
    successCount >= 3 ? 'high' : successCount >= 2 ? 'medium' : 'low';

  // Step 5: Save to engineering memory
  try {
    await saveRepairSuccess({
      errorPattern: extracted.errorPattern,
      rootCause: extracted.rootCause,
      fixApproach: extracted.fixApproach,
      targetFiles: extracted.targetFiles,
      tsErrorsToAvoid: extracted.tsErrorsToAvoid,
      successfulTier: ctx.successfulTier,
      ...(isAutoRepair && transformId ? { directTransform: transformId } : {}),
    });
  } catch { /* non-critical — memory save failure must never crash the repair */ }

  // Step 6: Verification — confirm TypeScript is still clean
  let verificationPassed = false;
  try {
    verificationPassed = await runVerification(ctx.projectPath);
  } catch { /* non-critical */ }

  // Step 7: Build the engine improvement message
  const autoTag = isAutoRepair
    ? `Auto-repair enabled — future "${extracted.rootCause.slice(0, 50)}" errors will be fixed without AI.`
    : confidence === 'medium'
    ? `Seen twice now — one more occurrence enables auto-repair.`
    : `Pattern recorded — engine will recognize this class of error.`;

  const engineImprovement =
    `**${cap.name}** learned a new pattern.\n` +
    `Root cause: _${extracted.rootCause}_\n` +
    `${autoTag}`;

  return {
    capabilityId: cap.id,
    capabilityName: cap.name,
    patternStored: extracted.rootCause,
    isAutoRepair,
    confidence,
    successCount,
    verificationPassed,
    directTransformId: isAutoRepair ? transformId : undefined,
    engineImprovement,
  };
}

// ─── Batch analysis: scan a project's error history ──────────────────────────
// Call this to retroactively learn from all past repair patterns.

export interface HistoricRepair {
  errorText: string;
  changedFiles: string[];
  userMessage: string;
  tier: 'HAIKU' | 'SONNET' | 'STRONGEST';
}

export async function learnFromHistory(
  repairs: HistoricRepair[],
  projectPath: string,
  callAI: (prompt: string, tier: 'HAIKU' | 'SONNET') => Promise<string>,
): Promise<LearningResult[]> {
  const results: LearningResult[] = [];
  for (const r of repairs) {
    try {
      const result = await learnFromRepair({
        errorText: r.errorText,
        changedFiles: r.changedFiles,
        userMessage: r.userMessage,
        successfulTier: r.tier,
        projectPath,
      }, callAI);
      results.push(result);
    } catch { /* skip failed entries */ }
  }
  return results;
}
