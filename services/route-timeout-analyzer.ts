/**
 * Route Timeout Analyzer
 *
 * Reads a route.ts file and identifies WHERE a timeout is most likely happening.
 * Called by the verification engine when a route exceeds the probe window.
 *
 * Detects:
 *   - fetch() calls with timeouts longer than the verification window
 *   - fetch() calls with NO timeout at all
 *   - Platform proxy calls (DWOMOH proxy at /api/api-manager/proxy)
 *   - Missing API key env vars that would cause hangs
 *   - Infinite loops / recursive retry patterns
 *   - SQLite / database lock patterns
 *
 * Returns a structured profile the repair engine can act on directly.
 */

import { readFile } from 'fs/promises';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimeoutCause =
  | 'platform-proxy-timeout'  // DWOMOH proxy call timeout > verification window
  | 'external-api-timeout'    // fetch() to external API with no / long timeout
  | 'missing-api-key'         // API key env var is undefined → route may hang or 503
  | 'unresolved-promise'      // await with no guaranteed resolution path
  | 'infinite-retry-loop'     // while(true) / recursive retry
  | 'database-lock'           // SQLite lock or Prisma connection timeout
  | 'no-error-handling'       // external fetch not in try/catch — uncaught error hangs response
  | 'unknown';

export interface CallSite {
  /** URL string (may be a template literal snippet) */
  url: string;
  /** Best-guess line number (1-based) */
  line: number;
  /** Detected timeout in ms, or null if none */
  timeoutMs: number | null;
  /** Whether this call is inside a try/catch */
  hasErrorHandling: boolean;
  /** Is this the DWOMOH platform proxy? */
  isPlatformProxy: boolean;
  /** Is this a RapidAPI / external sports/weather/etc API? */
  isExternalProvider: boolean;
  /** Environment variable used as API key, if detectable */
  apiKeyVar?: string;
  /** Human name of provider */
  provider?: string;
}

export interface RouteTimeoutProfile {
  primaryCause: TimeoutCause;
  secondaryCauses: TimeoutCause[];
  callSites: CallSite[];
  hasDbOperations: boolean;
  hasInfiniteLoop: boolean;
  /** Env vars that look like API keys but may not be set */
  apiKeyVars: string[];
  /** Which step is most likely hanging, in plain English */
  hangLocation: string;
  /** True when the route code is correct but external deps are unavailable */
  canSoftPass: boolean;
  /** Mock JSON shape to return when all external deps are unavailable */
  mockResponseShape: string;
  /** Full context block to inject into agent-fix prompt */
  repairContext: string;
  /** Suggested timing instrumentation for the route (per-step logs) */
  timingInstrumentation: string;
}

// ─── Detection patterns ───────────────────────────────────────────────────────

const PLATFORM_PROXY_RE = /api-manager\/proxy|DWOMOH_PLATFORM_URL|platformUrl/;
const RAPIDAPI_RE = /rapidapi\.com|x-rapidapi|X-RapidAPI/i;
const EXTERNAL_PROVIDER_RE =
  /https?:\/\/[a-zA-Z0-9.-]+\.(com|io|net|org|co)[/'"]/i;
const API_KEY_VAR_RE = /process\.env\.(\w*(?:API_KEY|RAPIDAPI|TOKEN|SECRET|KEY)\w*)/gi;
const ABORT_SIGNAL_RE = /AbortSignal\.timeout\((\d+)\)|new AbortController|signal:\s*\w+\.signal/g;
const DB_OP_RE = /db\.prepare\s*\(|\.query\s*\(|prisma\.\w+|sqlite|better-sqlite3|knex\b/i;
const LOOP_RE = /while\s*\(\s*true\s*\)|while\s*\(!done\)|while\s*\(retry\s*<|\brecurse\s*\(/i;

// ─── Line-by-line fetch() detector ───────────────────────────────────────────

function extractCallSites(src: string): CallSite[] {
  const lines = src.split('\n');
  const sites: CallSite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bfetch\s*\(/.test(line)) continue;

    // Collect surrounding context (5 lines before, 15 after)
    const ctxBefore = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    const ctxAfter  = lines.slice(i, Math.min(lines.length, i + 15)).join('\n');
    const fullCtx   = ctxBefore + '\n' + ctxAfter;

    // Detect URL
    const urlMatch =
      line.match(/fetch\s*\(\s*`([^`]{0,120})/)   ||
      line.match(/fetch\s*\(\s*['"]([^'"]{0,120})/) ||
      line.match(/fetch\s*\(\s*(\w[\w.]*)/);
    const url = urlMatch?.[1]?.trim() ?? '(dynamic URL)';

    // Detect timeout value
    let timeoutMs: number | null = null;
    const timeoutMatch = fullCtx.match(/AbortSignal\.timeout\((\d+)\)/);
    if (timeoutMatch) {
      timeoutMs = parseInt(timeoutMatch[1], 10);
    } else if (/signal:\s*\w+\.signal/.test(fullCtx)) {
      // AbortController used but value unknown — assume external
      timeoutMs = -1; // marker for "timeout exists but value unknown"
    }

    // Detect error handling
    const hasErrorHandling = /try\s*\{/.test(ctxBefore);

    const isPlatformProxy = PLATFORM_PROXY_RE.test(url) || PLATFORM_PROXY_RE.test(fullCtx);
    const isExternalProvider =
      RAPIDAPI_RE.test(url) || RAPIDAPI_RE.test(fullCtx) ||
      (EXTERNAL_PROVIDER_RE.test(url) && !isPlatformProxy);

    // Detect API key var
    const keyMatch = [...fullCtx.matchAll(API_KEY_VAR_RE)];
    const apiKeyVar = keyMatch[0]?.[1];

    // Provider name
    let provider: string | undefined;
    if (isPlatformProxy) provider = 'DWOMOH Platform Proxy';
    else if (/rapidapi/i.test(url) || /livescore|sports|football|nba/i.test(url)) provider = 'RapidAPI/Sports';
    else if (/weather|openmeteo|openweathermap/i.test(url)) provider = 'Weather API';
    else if (isExternalProvider) provider = 'External API';

    sites.push({
      url: url.slice(0, 100),
      line: i + 1,
      timeoutMs,
      hasErrorHandling,
      isPlatformProxy,
      isExternalProvider,
      apiKeyVar,
      provider,
    });
  }

  return sites;
}

// ─── Mock response generator ──────────────────────────────────────────────────

function inferMockShape(src: string, urlPath: string): string {
  // Try to infer from what keys the route accesses on the response
  const jsonAccessMatch = [...src.matchAll(/(?:json|data|result|res)\.([\w]+)/g)]
    .map(m => m[1])
    .filter(k => !['ok', 'status', 'headers', 'text', 'json'].includes(k));
  const uniqueKeys = [...new Set(jsonAccessMatch)].slice(0, 6);

  if (/sport|match|fixture|standing|football|league/i.test(urlPath + src)) {
    return JSON.stringify({
      matches: [],
      standings: [],
      teams: [],
      fixtures: [],
      _mock: true,
      _note: 'External sports API unavailable — showing empty data. Configure RAPIDAPI_KEY for live data.',
    }, null, 2);
  }
  if (/weather|temperature|forecast|climate/i.test(urlPath + src)) {
    return JSON.stringify({
      temperature: 25,
      condition: 'Clear',
      humidity: 60,
      _mock: true,
      _note: 'Weather API unavailable — showing placeholder data.',
    }, null, 2);
  }
  if (uniqueKeys.length > 0) {
    const shape: Record<string, unknown> = {};
    for (const k of uniqueKeys) {
      shape[k] = Array.isArray([]) ? [] : null;
    }
    shape['_mock'] = true;
    return JSON.stringify(shape, null, 2);
  }
  return JSON.stringify({ data: [], success: true, _mock: true, _note: 'External API unavailable.' }, null, 2);
}

// ─── Timing instrumentation template ─────────────────────────────────────────

function buildTimingInstrumentation(routeName: string, callSites: CallSite[]): string {
  const steps = callSites.map((s, i) =>
    `//   Step ${i + 2}: ${s.provider ?? 'External call'} at line ${s.line} (current timeout: ${s.timeoutMs !== null ? s.timeoutMs + 'ms' : 'NONE'})`
  ).join('\n');

  return `// ── Timing instrumentation (add at top of handler) ──────────────────
// Step 1: Route entered
// ${steps}
// Last step: Response sent
//
// Pattern to add before each external call:
//   const _t${routeName} = Date.now();
//   console.log('[${routeName}] Step N started');
//   // ... await fetch(url, { signal: AbortSignal.timeout(4000) })
//   console.log(\`[${routeName}] Step N completed (\${Date.now() - _t${routeName}}ms)\`);`;
}

// ─── Repair context builder ───────────────────────────────────────────────────

function buildRepairContext(
  profile: Omit<RouteTimeoutProfile, 'repairContext' | 'timingInstrumentation'>,
  verificationWindowMs: number,
): string {
  const lines: string[] = [
    '[TIMEOUT DIAGNOSIS — generated by static route analysis]',
    `Primary cause: ${profile.primaryCause.toUpperCase()}`,
    `Hang location: ${profile.hangLocation}`,
    '',
  ];

  if (profile.callSites.length > 0) {
    lines.push('EXTERNAL CALLS DETECTED:');
    for (const s of profile.callSites) {
      lines.push(`  Line ${s.line}: ${s.url}`);
      if (s.isPlatformProxy) {
        lines.push(`    → DWOMOH Platform Proxy (internal)`);
        if (s.timeoutMs !== null && s.timeoutMs > verificationWindowMs) {
          lines.push(`    ⚠ TIMEOUT TOO LONG: ${s.timeoutMs}ms > verification window ${verificationWindowMs}ms`);
          lines.push(`    FIX: Change AbortSignal.timeout(${s.timeoutMs}) to AbortSignal.timeout(${Math.floor(verificationWindowMs * 0.4)})`);
        } else if (s.timeoutMs === null) {
          lines.push(`    ⚠ NO TIMEOUT: this call can hang indefinitely`);
          lines.push(`    FIX: Add signal: AbortSignal.timeout(4000)`);
        }
      } else if (s.isExternalProvider) {
        lines.push(`    → External provider: ${s.provider ?? 'unknown'}`);
        if (s.timeoutMs === null) {
          lines.push(`    ⚠ NO TIMEOUT: add signal: AbortSignal.timeout(5000)`);
        } else if (s.timeoutMs > verificationWindowMs) {
          lines.push(`    ⚠ TIMEOUT TOO LONG: ${s.timeoutMs}ms > verification window`);
        }
        if (!s.hasErrorHandling) {
          lines.push(`    ⚠ NO TRY/CATCH: wrap in try/catch and return mock data on failure`);
        }
        if (s.apiKeyVar) {
          lines.push(`    API key: process.env.${s.apiKeyVar} (ensure this is set in .env.local)`);
        }
      }
    }
    lines.push('');
  }

  lines.push('REQUIRED FIXES (apply in order):');
  lines.push('1. Ensure ALL fetch() calls inside this route have a timeout <= 8000ms');
  lines.push('2. Wrap EVERY fetch() in try/catch — never let a network error propagate as an unhandled rejection');
  lines.push('3. Add a top-level env key check: if (!process.env.RAPIDAPI_KEY) return mock JSON immediately');
  lines.push('4. Return mock data (not an error) when external APIs are unavailable — the UI should show empty state, not crash');
  lines.push('');
  lines.push('MOCK DATA SHAPE (use this as the fallback return value):');
  lines.push(profile.mockResponseShape);

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Verification window in ms — all route calls must complete within this */
const VERIFICATION_WINDOW_MS = 9000;

export async function analyzeRouteForTimeout(
  absoluteFilePath: string,
  urlPath: string = '',
): Promise<RouteTimeoutProfile> {
  let src = '';
  try {
    src = await readFile(absoluteFilePath, 'utf-8');
  } catch {
    return {
      primaryCause: 'unknown',
      secondaryCauses: [],
      callSites: [],
      hasDbOperations: false,
      hasInfiniteLoop: false,
      apiKeyVars: [],
      hangLocation: 'Could not read route file',
      canSoftPass: false,
      mockResponseShape: '{}',
      repairContext: '[Route file unreadable — cannot diagnose timeout]',
      timingInstrumentation: '',
    };
  }

  const callSites = extractCallSites(src);
  const hasDbOperations = DB_OP_RE.test(src);
  const hasInfiniteLoop = LOOP_RE.test(src);

  // Collect all API key vars referenced
  const keyVarMatches = [...src.matchAll(API_KEY_VAR_RE)].map(m => m[1]);
  const apiKeyVars = [...new Set(keyVarMatches)];

  // ── Classify primary cause ─────────────────────────────────────────────────
  let primaryCause: TimeoutCause = 'unknown';
  const secondaryCauses: TimeoutCause[] = [];
  let hangLocation = 'Unknown step';

  // Check platform proxy calls with timeout > verification window
  const slowProxyCalls = callSites.filter(
    s => s.isPlatformProxy && s.timeoutMs !== null && s.timeoutMs > VERIFICATION_WINDOW_MS
  );
  const noTimeoutProxyCalls = callSites.filter(
    s => s.isPlatformProxy && s.timeoutMs === null
  );

  if (slowProxyCalls.length > 0) {
    primaryCause = 'platform-proxy-timeout';
    hangLocation = `Platform proxy call at line ${slowProxyCalls[0].line} has timeout ${slowProxyCalls[0].timeoutMs}ms — longer than the ${VERIFICATION_WINDOW_MS}ms verification window`;
  } else if (noTimeoutProxyCalls.length > 0) {
    primaryCause = 'platform-proxy-timeout';
    hangLocation = `Platform proxy call at line ${noTimeoutProxyCalls[0].line} has NO timeout — can hang indefinitely`;
  }

  // Check external API calls with long or missing timeouts
  const slowExternalCalls = callSites.filter(
    s => s.isExternalProvider && (s.timeoutMs === null || s.timeoutMs > VERIFICATION_WINDOW_MS)
  );
  if (slowExternalCalls.length > 0) {
    if (primaryCause === 'unknown') {
      primaryCause = 'external-api-timeout';
      hangLocation = `External API call at line ${slowExternalCalls[0].line} (${slowExternalCalls[0].url.slice(0, 60)}) with ${slowExternalCalls[0].timeoutMs === null ? 'no' : 'too-long'} timeout`;
    } else {
      secondaryCauses.push('external-api-timeout');
    }
  }

  // External calls without error handling
  const unprotectedCalls = callSites.filter(s => !s.hasErrorHandling);
  if (unprotectedCalls.length > 0) {
    secondaryCauses.push('no-error-handling');
  }

  if (hasInfiniteLoop) {
    if (primaryCause === 'unknown') primaryCause = 'infinite-retry-loop';
    else secondaryCauses.push('infinite-retry-loop');
    hangLocation = 'Infinite loop or recursive retry pattern detected';
  }

  if (hasDbOperations && primaryCause === 'unknown') {
    primaryCause = 'database-lock';
    hangLocation = 'Database operation detected — possible lock or connection timeout';
  }

  // Routes with all external calls having proper timeouts probably have a different issue
  if (primaryCause === 'unknown' && callSites.every(s => s.timeoutMs !== null && s.timeoutMs <= VERIFICATION_WINDOW_MS)) {
    primaryCause = 'unresolved-promise';
    hangLocation = 'Route has timeouts but still hung — likely an unresolved promise or missing return statement';
  }

  // ── canSoftPass: route code is correct, just needs live external API ───────
  // True when: primary cause is platform-proxy or external-api, and the route
  // has a key-missing check or the call is already in a try/catch fallback.
  const hasKeyCheck = /if\s*\(!key\)|if\s*\(!process\.env/i.test(src);
  const allExternalCallsProtected = callSites.every(s => s.hasErrorHandling);
  const canSoftPass =
    (primaryCause === 'platform-proxy-timeout' || primaryCause === 'external-api-timeout') &&
    (hasKeyCheck || allExternalCallsProtected || callSites.some(s => s.isPlatformProxy));

  const mockResponseShape = inferMockShape(src, urlPath);
  const routeName = urlPath.split('/').filter(Boolean).join('-') || 'route';

  const partialProfile = {
    primaryCause,
    secondaryCauses,
    callSites,
    hasDbOperations,
    hasInfiniteLoop,
    apiKeyVars,
    hangLocation,
    canSoftPass,
    mockResponseShape,
  };

  const repairContext = buildRepairContext(partialProfile, VERIFICATION_WINDOW_MS);
  const timingInstrumentation = buildTimingInstrumentation(routeName, callSites);

  return {
    ...partialProfile,
    repairContext,
    timingInstrumentation,
  };
}
