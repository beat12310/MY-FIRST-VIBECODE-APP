/**
 * Safe parsing for the builder's fetch responses.
 *
 * Root cause this fixes: the live build pipeline's client-side api() helper
 * (app/builder/page.tsx) called `res.json()` directly with no guard. A
 * build request commonly runs for minutes (build + repair + verify), and
 * any non-JSON response along the way -- a serverless function timeout/
 * crash page from the hosting infrastructure, a proxy error, or an
 * uncaught exception slipping past the route's own try/catch -- makes
 * `res.json()` throw "Unexpected token ... is not valid JSON", an
 * uncaught error that crashed the ENTIRE build with a cryptic,
 * browser-only message instead of a clear, recoverable one.
 *
 * parseApiResponse reads the body as text first (which never throws), logs
 * it safely (truncated, never assumes it's short), then attempts JSON.parse
 * in a controlled way -- returning the SAME `{ success: false, error }`
 * shape every other API response already uses, so every existing caller's
 * `if (!result.success)` handling works unchanged.
 */

export interface ApiParseResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

const RAW_BODY_LOG_LIMIT = 500;

export function parseApiResponse(rawText: string, status: number, ok: boolean): ApiParseResult {
  if (!rawText) {
    return { success: false, error: ok ? 'The server returned an empty response. Please try again.' : `Request failed (${status}).` };
  }

  try {
    const parsed = JSON.parse(rawText);
    // A valid JSON response that isn't an object (e.g. a bare string/number)
    // is still not a usable API result -- treat it the same as a parse failure.
    if (parsed === null || typeof parsed !== 'object') {
      return { success: false, error: 'The server returned an unexpected response. Please try again.' };
    }
    return parsed as ApiParseResult;
  } catch {
    return {
      success: false,
      error: ok
        ? 'The server returned an unexpected response. Please try again.'
        : `Request failed (${status}). Please try again.`,
    };
  }
}

/** Truncates a raw response body for safe logging -- never assumes it's short. */
export function truncateForLog(rawText: string, limit: number = RAW_BODY_LOG_LIMIT): string {
  if (rawText.length <= limit) return rawText;
  return `${rawText.slice(0, limit)}… (${rawText.length} chars total)`;
}
