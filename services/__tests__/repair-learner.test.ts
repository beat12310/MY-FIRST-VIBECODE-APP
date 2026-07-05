import { describe, it, expect, vi } from 'vitest';
import { learnFromRepair, type RepairContext } from '../repair-learner';

/**
 * Regression coverage for the live build pipeline JSON parsing failure:
 * services/repair-learner.ts's pattern-extraction prompt is the one place
 * in this codebase that actually asks the model for raw JSON output
 * ("OUTPUT a JSON object ... raw JSON only"), unlike the main build/
 * generation pipeline (a delimiter format specifically avoids JSON
 * parsing). The old implementation used a naive /\{[\s\S]*\}/ regex + bare
 * JSON.parse with no recovery path and no re-ask on failure -- a malformed
 * response (markdown fences, truncation, extra prose) silently gave up on
 * the first try. These tests mock engineering-memory/capability-registry so
 * only the pattern-extraction behavior itself is under test.
 */
vi.mock('../engineering-memory', () => ({
  findMatchingRepair: vi.fn().mockResolvedValue(null),
  saveRepairSuccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../capability-registry', () => ({
  classifyCapability: vi.fn().mockReturnValue(null),
}));

const baseCtx: RepairContext = {
  errorText: 'TS2305: Module has no exported member "auth"',
  changedFiles: ['lib/managed/auth.ts'],
  userMessage: 'fix the login error',
  successfulTier: 'SONNET',
  projectPath: '/tmp/test-project',
};

describe('learnFromRepair — pattern extraction from a real "ask the model for JSON" prompt', () => {
  it('parses a clean JSON response on the first try', async () => {
    const callAI = vi.fn().mockResolvedValue(JSON.stringify({
      errorPattern: 'no exported member "auth"',
      rootCause: 'auth.ts missing the auth export',
      fixApproach: 'Re-export auth from lib/managed/auth.ts',
      tsErrorsToAvoid: ['TS2305'],
      targetFiles: ['lib/managed/auth.ts'],
    }));

    const result = await learnFromRepair(baseCtx, callAI);

    expect(callAI).toHaveBeenCalledTimes(1); // no re-ask needed
    expect(result.patternStored).toBe('auth.ts missing the auth export');
  });

  it('parses JSON wrapped in markdown code fences (a common model deviation)', async () => {
    const callAI = vi.fn().mockResolvedValue(
      '```json\n' + JSON.stringify({
        errorPattern: 'no exported member',
        rootCause: 'missing export',
        fixApproach: 'add the export',
        tsErrorsToAvoid: [],
        targetFiles: [],
      }) + '\n```'
    );

    const result = await learnFromRepair(baseCtx, callAI);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(result.patternStored).toBe('missing export');
  });

  it('re-asks the model ONCE when the first response is not valid JSON, and succeeds on the retry', async () => {
    const callAI = vi.fn()
      .mockResolvedValueOnce('Sure! Here is my analysis: the error is caused by a missing export.') // not JSON at all
      .mockResolvedValueOnce(JSON.stringify({
        errorPattern: 'no exported member',
        rootCause: 'missing export after retry',
        fixApproach: 'add the export',
        tsErrorsToAvoid: [],
        targetFiles: [],
      }));

    const result = await learnFromRepair(baseCtx, callAI);

    expect(callAI).toHaveBeenCalledTimes(2); // exactly one re-ask, not unbounded retries
    expect(result.patternStored).toBe('missing export after retry');
  });

  it('never crashes the build when BOTH attempts fail — falls back to a minimal pattern built from known context', async () => {
    const callAI = vi.fn().mockResolvedValue('not json at all, just prose');

    const result = await learnFromRepair(baseCtx, callAI);

    expect(callAI).toHaveBeenCalledTimes(2); // tried once, re-asked once, then gave up gracefully
    expect(result).toBeTruthy();
    expect(result.patternStored).toBeTruthy(); // minimal fallback pattern, not a thrown error
  });

  it('never crashes the build when callAI itself throws (e.g. the model call fails)', async () => {
    const callAI = vi.fn().mockRejectedValue(new Error('Bedrock throttled'));

    await expect(learnFromRepair(baseCtx, callAI)).resolves.toBeTruthy();
  });

  it('rejects JSON missing required fields instead of returning a half-formed pattern', async () => {
    const callAI = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ errorPattern: 'x' })) // missing rootCause/fixApproach
      .mockResolvedValueOnce(JSON.stringify({
        errorPattern: 'x', rootCause: 'y', fixApproach: 'z', tsErrorsToAvoid: [], targetFiles: [],
      }));

    const result = await learnFromRepair(baseCtx, callAI);

    expect(callAI).toHaveBeenCalledTimes(2); // first response rejected for missing fields, re-asked
    expect(result.patternStored).toBe('y');
  });
});
