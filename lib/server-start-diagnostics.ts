/**
 * Classifies a generated-app dev-server start failure as "environmental"
 * (something about the execution environment, not the generated app's own
 * code) vs a genuine code problem the AI-repair strategies can actually fix.
 *
 * Root cause this exists for: a real production failure where the
 * generated app's dev server crashed with
 * "[x-amplify-credentials] Credential listener could not be started:
 * Error: listen" — caused by the dev server's child process inheriting
 * Amplify-Hosting/Lambda-specific environment variables from the platform's
 * own production process (see services/project-runner.ts's
 * buildIsolatedDevServerEnv, the structural fix). Before that fix existed,
 * the builder's 3-strategy retry loop (app/builder/page.tsx) burned all 3
 * attempts on an error that could never be fixed by editing the generated
 * app's source — Strategy 1's "classify + fix" and Strategy 2's "AI code
 * fix + cache clear" are both aimed at CODE problems, and retrying an
 * environmental failure with the same poisoned environment can only ever
 * fail identically. This is what "Advanced repair finished — 0 file(s)
 * changed, but some checks may still be failing" looked like to the user:
 * the AI correctly found nothing wrong with the code, because there never
 * was anything wrong with the code.
 *
 * Used to skip straight to an honest, environment-specific message instead
 * of wasting 2 more retries and an AI repair cycle on an unfixable error.
 */

const ENVIRONMENTAL_SERVER_ERROR_PATTERNS: RegExp[] = [
  /x-amplify-credentials/i,
  /credential listener/i,
  /EADDRINUSE/,
  /EACCES/,
  /Error:\s*listen\b/i,
  /listen\s+EACCES|listen\s+EADDRINUSE/i,
];

export function isEnvironmentalServerError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  return ENVIRONMENTAL_SERVER_ERROR_PATTERNS.some(re => re.test(errorMsg));
}

/**
 * True when two consecutive server-start failures report the exact same
 * error text — a sign that whatever the last retry attempt changed had no
 * effect, so continuing to retry the same way cannot help either.
 */
export function isIdenticalRepeatedError(previous: string, current: string): boolean {
  if (!previous || !current) return false;
  return previous.trim() === current.trim();
}
