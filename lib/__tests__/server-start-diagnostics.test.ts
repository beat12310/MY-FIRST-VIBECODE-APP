import { describe, it, expect } from 'vitest';
import { isEnvironmentalServerError, isIdenticalRepeatedError, hasNoActionableCodeEvidence } from '../server-start-diagnostics';

/**
 * Regression coverage for a real live-production incident: a generated
 * app's dev server failed to start with "[x-amplify-credentials]
 * Credential listener could not be started: Error: listen" -- the builder's
 * 3-strategy retry loop burned all 3 attempts (including two AI code-fix
 * cycles) on an error that could never be fixed by editing the generated
 * app's source, surfacing to the user as "Advanced repair finished — 0
 * file(s) changed, but some checks may still be failing."
 */
describe('isEnvironmentalServerError — the exact live production failure', () => {
  it('recognizes the exact reported error text', () => {
    expect(isEnvironmentalServerError('[x-amplify-credentials] Credential listener could not be started: Error: listen')).toBe(true);
  });

  it('recognizes a bare "Credential listener" message', () => {
    expect(isEnvironmentalServerError('Credential listener failed')).toBe(true);
  });

  it('recognizes EADDRINUSE (port already in use)', () => {
    expect(isEnvironmentalServerError('Error: listen EADDRINUSE: address already in use :::3001')).toBe(true);
  });

  it('recognizes EACCES (permission denied binding a socket)', () => {
    expect(isEnvironmentalServerError('Error: listen EACCES: permission denied 0.0.0.0:80')).toBe(true);
  });

  it('does NOT flag a genuine code problem as environmental', () => {
    expect(isEnvironmentalServerError('TS2305: Module has no exported member "auth"')).toBe(false);
    expect(isEnvironmentalServerError('SyntaxError: Unexpected token )')).toBe(false);
    expect(isEnvironmentalServerError('Module not found: Cannot resolve "./missing-file"')).toBe(false);
  });

  it('does not throw and returns false for an empty/missing error message', () => {
    expect(isEnvironmentalServerError('')).toBe(false);
  });
});

describe('isIdenticalRepeatedError — stall detection across retry attempts', () => {
  it('detects an identical error repeated verbatim', () => {
    expect(isIdenticalRepeatedError('Error: listen EADDRINUSE', 'Error: listen EADDRINUSE')).toBe(true);
  });

  it('tolerates surrounding whitespace differences', () => {
    expect(isIdenticalRepeatedError('  Error: listen EADDRINUSE  ', 'Error: listen EADDRINUSE')).toBe(true);
  });

  it('does NOT flag genuinely different errors as identical (real progress between retries)', () => {
    expect(isIdenticalRepeatedError('TS2305: Missing export "auth"', 'TS2345: Argument type mismatch')).toBe(false);
  });

  it('returns false when either input is empty (nothing to compare yet)', () => {
    expect(isIdenticalRepeatedError('', 'some error')).toBe(false);
    expect(isIdenticalRepeatedError('some error', '')).toBe(false);
  });
});

/**
 * Regression coverage for a real live-production failure: a server-start
 * crash that produced an EMPTY/near-empty log fell through
 * isEnvironmentalServerError's keyword matching (there was nothing to
 * match against) and was escalated to "Advanced repair" anyway, which
 * correctly reported "0 file(s) changed" -- there was no code-level
 * evidence of anything to fix, environmental or otherwise.
 * hasNoActionableCodeEvidence closes this gap: a genuinely empty or
 * generic-fallback crash message is just as unfixable-by-AI as a
 * recognized environmental error.
 */
describe('hasNoActionableCodeEvidence — closes the "empty crash log" gap', () => {
  it('treats a completely empty error as having no actionable evidence', () => {
    expect(hasNoActionableCodeEvidence('')).toBe(true);
  });

  it('treats the generic "Server exited unexpectedly at startup" fallback as having no actionable evidence', () => {
    expect(hasNoActionableCodeEvidence('Server exited unexpectedly at startup\n[intended preview port=3001]')).toBe(true);
  });

  it('treats "no error captured"/"no error detail captured" fallbacks as having no actionable evidence', () => {
    expect(hasNoActionableCodeEvidence('No error captured')).toBe(true);
    expect(hasNoActionableCodeEvidence('No error detail captured')).toBe(true);
  });

  it('still recognizes known environmental errors (delegates to isEnvironmentalServerError)', () => {
    expect(hasNoActionableCodeEvidence('[x-amplify-credentials] Credential listener could not be started: Error: listen')).toBe(true);
  });

  it('does NOT flag a genuine, specific code error as having no actionable evidence', () => {
    expect(hasNoActionableCodeEvidence('TS2305: Module has no exported member "auth"\n[intended preview port=3001]')).toBe(false);
    expect(hasNoActionableCodeEvidence('SyntaxError: Unexpected token )')).toBe(false);
  });
});
