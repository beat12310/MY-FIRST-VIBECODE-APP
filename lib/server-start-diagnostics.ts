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

// A crash with NO captured detail at all is just as unfixable-by-AI as a
// recognized environmental error — arguably more so, since there is
// LITERALLY NOTHING for a code-fix strategy to act on. Confirmed live: a
// crash that produced an empty/near-empty log fell through
// isEnvironmentalServerError's keyword matching (nothing to match against)
// and was escalated to "Advanced repair" anyway, which correctly reported
// "0 file(s) changed" -- there was no code-level evidence of anything to
// fix, environmental or otherwise. This is what the fallback text
// ("Server exited unexpectedly at startup", "No error detail captured")
// looks like once analyzeCrashLog's portDiagnostic suffix is stripped off.
const GENERIC_NO_DETAIL_PATTERNS: RegExp[] = [
  /^server exited unexpectedly/i,
  /^no error captured/i,
  /^no error detail captured/i,
];

// Confirmed live: "next: command not found" -- npm install reported
// success (or "failed, continuing with available packages") without `next`
// actually landing in node_modules, and the dev server crashed trying to
// run a bare `next` that node_modules/.bin never provided. This is
// EQUALLY unfixable by an AI code-repair cycle (editing source files
// cannot install a package) as a recognized environmental error --
// services/project-runner.ts's startDevServer already attempts one
// automatic reinstall-and-retry internally; if the error still surfaces
// here, that retry already failed, so further AI-repair attempts are
// just as futile as escalating on an environmental error.
const MISSING_DEPENDENCY_PATTERNS: RegExp[] = [
  /command not found/i,
  /cannot find module ['"]next['"]|cannot find module ['"]react/i,
  /is not installed in node_modules/i,
];

export function isMissingDependencyError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  return MISSING_DEPENDENCY_PATTERNS.some(re => re.test(errorMsg));
}

/**
 * True when a server-start error gives NO real, specific evidence of a code
 * problem -- either a recognized environmental error, a missing-dependency
 * error, or just a generic, contentless "it crashed" message with nothing
 * else to go on. All three cases mean escalating to an AI code-repair
 * cycle cannot possibly help.
 */
export function hasNoActionableCodeEvidence(errorMsg: string): boolean {
  if (!errorMsg || !errorMsg.trim()) return true;
  if (isEnvironmentalServerError(errorMsg)) return true;
  if (isMissingDependencyError(errorMsg)) return true;
  // Strip the "[intended preview port=...]" diagnostic suffix that
  // analyzeCrashLog always appends, even to an otherwise-empty crash,
  // before checking whether what's LEFT is itself just a generic fallback.
  const withoutPortDiag = errorMsg.replace(/\n?\[intended preview port=.*?\]\s*$/i, '').trim();
  return GENERIC_NO_DETAIL_PATTERNS.some(re => re.test(withoutPortDiag));
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
