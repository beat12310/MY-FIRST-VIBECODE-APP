import { describe, it, expect } from 'vitest';
import { parseApiResponse, truncateForLog } from '../safe-json-response';

/**
 * Regression coverage for a real live-production incident: the DWOMOH Vibe
 * Code builder failed on dwomohvibe.com during a normal build request with
 * "Unexpected token ... is not valid JSON". Root cause: app/builder/page.tsx's
 * api() helper called res.json() directly with no guard — a build request
 * commonly runs for minutes, and any non-JSON response along the way (a
 * serverless timeout/crash page, a proxy error, a truncated body) threw an
 * uncaught error that crashed the entire build with a cryptic message
 * instead of a clear, recoverable one.
 */
describe('parseApiResponse — the live build pipeline JSON parsing failure', () => {
  it('parses a normal, valid JSON response exactly as before', () => {
    const result = parseApiResponse('{"success":true,"filesCreated":["app/page.tsx"]}', 200, true);
    expect(result).toEqual({ success: true, filesCreated: ['app/page.tsx'] });
  });

  it('does NOT throw on an HTML crash/timeout page — the exact live failure shape', () => {
    // This is the literal shape of what a serverless function timeout or
    // crash page looks like: HTML starting with "<", which V8's JSON.parse
    // rejects with "Unexpected token < in JSON at position 0" -- the exact
    // browser error reported in production.
    const htmlCrashPage = '<html><head><title>504 Gateway Time-out</title></head><body>...</body></html>';
    expect(() => parseApiResponse(htmlCrashPage, 504, false)).not.toThrow();
    const result = parseApiResponse(htmlCrashPage, 504, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('504');
  });

  it('does NOT throw on truncated/malformed JSON (a response cut off mid-stream)', () => {
    const truncated = '{"success":true,"filesCreated":["app/page.tsx","app/lay';
    expect(() => parseApiResponse(truncated, 200, true)).not.toThrow();
    const result = parseApiResponse(truncated, 200, true);
    expect(result.success).toBe(false);
  });

  it('does NOT throw on plain-text error output (e.g. a proxy error page)', () => {
    const plainText = 'Internal Server Error';
    expect(() => parseApiResponse(plainText, 500, false)).not.toThrow();
    expect(parseApiResponse(plainText, 500, false).success).toBe(false);
  });

  it('treats an empty response body as a clear failure, not a crash', () => {
    const result = parseApiResponse('', 200, true);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('treats valid-JSON-but-non-object responses (e.g. a bare string) as a failure, not a false success', () => {
    const result = parseApiResponse('"just a string"', 200, true);
    expect(result.success).toBe(false);
  });

  it('preserves extra fields on a successful response (callers destructure arbitrary properties)', () => {
    const result = parseApiResponse('{"success":true,"filesCreated":["a.tsx"],"instructions":"done"}', 200, true);
    expect(result.filesCreated).toEqual(['a.tsx']);
    expect(result.instructions).toBe('done');
  });
});

describe('truncateForLog — safe logging of raw response bodies', () => {
  it('leaves short text untouched', () => {
    expect(truncateForLog('short')).toBe('short');
  });

  it('truncates long text and reports the original length', () => {
    const long = 'x'.repeat(1000);
    const result = truncateForLog(long, 500);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('1000 chars total');
  });
});
