/**
 * Verification Engine — Rule 10
 * After every build or edit, make real HTTP requests to verify the app works.
 * Always read the response body on failure to find the REAL root cause.
 */

// ─── Root cause types ─────────────────────────────────────────────────────────

export interface CheckRootCause {
  kind: 'missing-package' | 'auth-misconfigured' | 'missing-env' | 'typescript-error' | 'runtime-crash' | 'route-failure' | 'wrong-http-method' | 'timeout' | 'database-error' | 'preview-blank' | 'provider-misconfigured' | 'scaffold-placeholder' | 'unknown';
  detail: string;           // plain-English description
  packages?: string[];      // for missing-package: npm package names to install
  envVars?: string[];       // for missing-env: env var names to add
  errorText?: string;       // raw excerpt from the response body (for logs only)
  /** Suggested fix: the specific source file to edit */
  fixFile?: string;
  /** Suggested fix: concrete action for the agent */
  fixHint?: string;
}

export interface VerificationCheck {
  name: string;
  url: string;
  passed: boolean;
  statusCode?: number;
  dataFound?: boolean;
  recordCount?: number;
  responsePreview?: string;
  error?: string;
  rootCause?: CheckRootCause;
  /** Source file most likely responsible for this failure */
  fixFile?: string;
  /** Concise fix description for the agent prompt */
  fixHint?: string;
}

export interface VerificationResult {
  verified: boolean;
  port: number;
  checks: VerificationCheck[];
  failures: string[];
  summary: string;
}

// ─── Root cause extraction ────────────────────────────────────────────────────

const MODULE_NOT_FOUND_PATTERNS = [
  /Module not found:.*?Can't resolve ['"]([^'"]+)['"]/i,
  /Cannot find module ['"]([^'"]+)['"]/i,
  /Failed to resolve import ['"]([^'"]+)['"]/i,
  /error TS2307: Cannot find module ['"]([^'"]+)['"]/i,
];

const AUTH_ERROR_PATTERNS = [
  /NEXTAUTH_SECRET/i,
  /AUTH_SECRET/i,
  /\[next-auth\]/i,
  /next-auth.*(?:secret|error|missing)/i,
];

const MISSING_ENV_PATTERNS = [
  /process\.env\.(\w+) is (?:undefined|not set|null)/i,
  /Missing.*environment variable.*?['"]?([\w_]+)['"]?/i,
  /Please define the ([\w_]+) environment variable/i,
];

const DATABASE_ERROR_PATTERNS = [
  /SQLITE_ERROR/i,
  /SQLITE_BUSY/i,
  /SQLITE_CANTOPEN/i,
  /SQLITE_NOTADB/i,
  /no such table:\s*([\w_]+)/i,
  /no such column:\s*([\w_]+)/i,
  /database is locked/i,
  /PrismaClientKnownRequestError/i,
  /PrismaClientInitializationError/i,
  /PrismaClientValidationError/i,
  /relation "[\w_]+" does not exist/i,
  /Table '[\w.]+'.*doesn't exist/i,
  /column "[\w_]+" of relation/i,
  /better-sqlite3/i,
  /sqlite3.*error/i,
];

const PREVIEW_BLANK_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\d]+ failed/i,
  /Hydration.*mismatch/i,
  /Text content does not match/i,
  /Minified React error/i,
  /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
];

// Patterns that identify the DWOMOH scaffold placeholder page — the "Building your app"
// loading screen that is served when AI generation was incomplete or failed. A 200 on
// this page must NOT count as a passing verification check.
const SCAFFOLD_PLACEHOLDER_PATTERNS = [
  /Building your app.*the agent is generating/i,
  /the agent is generating the full codebase/i,
  /animate-pulse.*Generating/i,
  /Generating….*animate-pulse/i,
  // Matches the exact text in the scaffold page.tsx
  /the agent is generating the full codebase now/i,
];

// Patterns that indicate a route is failing because of a bad external API integration,
// not a code bug that a generic TS fix can solve. Matching these triggers the
// 'provider-misconfigured' kind, which escalates to a provider-aware repair pass.
const PROVIDER_ERROR_PATTERNS = [
  // RapidAPI-specific
  /x-rapidapi/i,
  /rapidapi\.com/i,
  /You are not subscribed to this API/i,
  /Invalid API key/i,
  // Upstream HTTP errors from a fetch() inside a route handler
  /upstream\s+(?:api|service|server)/i,
  /external\s+(?:api|service)/i,
  // fetch() failure patterns
  /fetch\s+failed/i,
  /ECONNREFUSED.*(?:api|external)/i,
  // JSON parse failures that indicate the API returned something unexpected
  /Unexpected token.*JSON/i,
  /SyntaxError.*JSON\.parse/i,
  // Rate limiting or quota from a provider
  /rate.?limit(?:ed)?/i,
  /too many requests/i,
  /quota.?exceed/i,
  // Response shape mismatches — the API changed its schema or the wrong endpoint is called
  /Cannot read propert(?:y|ies) of undefined.*(?:data|result|items|response|body|json)/i,
  /is not a function.*(?:map|filter|forEach)/i,
  // Provider name pattern — "SomeProvider API error"
  /provider.*error/i,
  /api.*(?:key|token|credential).*(?:invalid|expired|missing)/i,
];

function isLocalAlias(p: string): boolean {
  return p.startsWith('@/') || p.startsWith('./') || p.startsWith('../');
}

function moduleToPackage(modulePath: string): string {
  if (modulePath.startsWith('@')) return modulePath.split('/').slice(0, 2).join('/');
  return modulePath.split('/')[0];
}

/**
 * Parse the response body (HTML or JSON from Next.js error page) to extract
 * the actual root cause of the failure. Never guess from the HTTP status alone.
 */
function parseRootCause(body: string, statusCode: number): CheckRootCause {
  // Strip HTML tags for easier pattern matching
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);

  // 1. Missing npm package (most common compile-time failure)
  for (const re of MODULE_NOT_FOUND_PATTERNS) {
    const m = re.exec(text) ?? re.exec(body);
    if (m && !isLocalAlias(m[1])) {
      const pkg = moduleToPackage(m[1]);
      return {
        kind: 'missing-package',
        detail: `Missing npm package: **${pkg}**`,
        packages: [pkg],
        errorText: text.slice(0, 400),
      };
    }
  }

  // 2. Database errors — check before generic server crash so they get a specific kind
  for (const re of DATABASE_ERROR_PATTERNS) {
    if (re.test(text)) {
      return {
        kind: 'database-error',
        detail: `Database error: ${text.match(re)?.[0]?.slice(0, 80) ?? 'query failed'}`,
        errorText: text.slice(0, 400),
        fixHint: 'Check that initTable() is called before queries, column names match the schema, and the db file is writable',
      };
    }
  }

  // 3. Auth misconfiguration
  if (AUTH_ERROR_PATTERNS.some(re => re.test(text))) {
    return {
      kind: 'auth-misconfigured',
      detail: 'Authentication is not configured (missing secret key)',
      errorText: text.slice(0, 200),
    };
  }

  // 4. Missing environment variable
  for (const re of MISSING_ENV_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const varName = m[1];
      return {
        kind: 'missing-env',
        detail: `Missing environment variable: **${varName}**`,
        envVars: [varName],
        errorText: text.slice(0, 200),
      };
    }
  }

  // 5. Preview / hydration / chunk-load errors
  for (const re of PREVIEW_BLANK_PATTERNS) {
    if (re.test(text)) {
      return {
        kind: 'preview-blank',
        detail: `Preview/hydration error: ${text.match(re)?.[0]?.slice(0, 80) ?? 'client-side render failed'}`,
        errorText: text.slice(0, 300),
        fixHint: 'Check for server/client mismatches, missing "use client" directives, or invalid hook usage',
      };
    }
  }

  // 6. TypeScript compile error
  if (/error TS\d+/i.test(text)) {
    return {
      kind: 'typescript-error',
      detail: 'TypeScript compile error in a source file',
      errorText: text.slice(0, 400),
    };
  }

  // 7. Wrong HTTP method (405)
  if (statusCode === 405) {
    return {
      kind: 'wrong-http-method',
      detail: 'Route returned 405 — handler exports the wrong HTTP method (GET vs POST vs PUT)',
      errorText: text.slice(0, 200),
      fixHint: 'Ensure the route.ts exports the correct HTTP method function (export async function GET / POST / PUT / DELETE)',
    };
  }

  // 7b. External API / provider integration error — detect before generic 500 handler
  // so provider-aware escalation kicks in instead of a blind code fix.
  if (statusCode >= 400 || statusCode === 0) {
    for (const re of PROVIDER_ERROR_PATTERNS) {
      if (re.test(text)) {
        const snippet = text.match(re)?.[0]?.slice(0, 100) ?? 'provider call failed';
        return {
          kind: 'provider-misconfigured',
          detail: `External API integration error: ${snippet}`,
          errorText: text.slice(0, 400),
          fixHint:
            'This route is calling an external API incorrectly. Check the provider endpoint URL, ' +
            'authentication headers (X-RapidAPI-Key, X-RapidAPI-Host, Authorization), and the ' +
            'response parsing code. Use the DWOMOH Provider Engine to find the correct provider.',
        };
      }
    }
  }

  // 8. Runtime server crash (500)
  if (statusCode >= 500) {
    const errMsg = /(?:Error|TypeError|ReferenceError|SyntaxError):\s+([^\n.]{5,100})/i.exec(text)?.[1];
    return {
      kind: 'runtime-crash',
      detail: errMsg ? `Server error: ${errMsg}` : `Server returned HTTP ${statusCode}`,
      errorText: text.slice(0, 400),
      fixHint: errMsg ? `Find and fix: ${errMsg}` : 'Wrap the throwing code in try/catch and return safe JSON on error',
    };
  }

  // 9. Not found (404) — route missing entirely
  if (statusCode === 404) {
    return {
      kind: 'route-failure',
      detail: 'Route does not exist (404) — the file may be missing or the path is wrong',
      errorText: text.slice(0, 200),
      fixHint: 'Create the missing route file or fix the URL path',
    };
  }

  // 10. Other 4xx
  if (statusCode >= 400) {
    return {
      kind: 'route-failure',
      detail: `Route returned HTTP ${statusCode}`,
      errorText: text.slice(0, 200),
    };
  }

  return { kind: 'unknown', detail: `HTTP ${statusCode}` };
}

// ─── Source-file derivation ────────────────────────────────────────────────────

/** Derive the most likely source file responsible for a failing URL. */
function urlToFixFile(urlPath: string): string | undefined {
  if (urlPath === '/' || urlPath === '') return 'app/page.tsx';
  if (urlPath.startsWith('/api/')) {
    const apiPart = urlPath.replace(/^\/api\//, '').replace(/\/+$/, '');
    // Skip dynamic segments — can't guess the exact file
    if (apiPart.includes('[')) return undefined;
    return `app/api/${apiPart}/route.ts`;
  }
  // Page routes: /dashboard → app/dashboard/page.tsx
  const clean = urlPath.replace(/^\//, '').replace(/\/+$/, '');
  if (clean && !clean.includes('[') && !clean.includes('?')) {
    return `app/${clean}/page.tsx`;
  }
  return undefined;
}

// ─── Endpoint checker ─────────────────────────────────────────────────────────

function apiRouteFileToUrlPath(routeFile: string): string | null {
  if (routeFile.includes('[')) return null;
  return routeFile
    .replace(/^app/, '')
    .replace(/\/route\.(ts|tsx|js|jsx)$/, '');
}

async function checkEndpoint(
  url: string,
  name: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<VerificationCheck> {
  const urlPath = new URL(url).pathname;
  const suggestedFixFile = urlToFixFile(urlPath);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const fetchOpts: RequestInit = {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html', 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
    };

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text().catch(() => '');

    // ── 405: wrong HTTP method — automatically try the other common methods ──
    if (res.status === 405 && method === 'GET') {
      // Try POST to see if route is POST-only (common for mutation routes)
      const postCtrl = new AbortController();
      const postTimer = setTimeout(() => postCtrl.abort(), 5000);
      try {
        const postRes = await fetch(url, {
          method: 'POST',
          signal: postCtrl.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({}),
        });
        clearTimeout(postTimer);
        if (postRes.ok) {
          // Route works via POST — this is a verification quirk, not a code bug
          return {
            name: `${name} (POST)`,
            url,
            passed: true,
            statusCode: postRes.status,
            dataFound: true,
            responsePreview: '(POST endpoint — verified with POST probe)',
          };
        }
      } catch { clearTimeout(postTimer); }

      // Still 405 — the route file is missing the correct handler export
      const rootCause = parseRootCause(bodyText, 405);
      rootCause.fixFile = suggestedFixFile;
      return {
        name,
        url,
        passed: false,
        statusCode: 405,
        rootCause,
        error: rootCause.detail,
        fixFile: suggestedFixFile,
        fixHint: `Check ${suggestedFixFile ?? 'the route file'} — ensure it exports "export async function GET" or the correct HTTP method`,
      };
    }

    // ── Failure: read body to find real root cause ─────────────────────────
    if (!res.ok) {
      const rootCause = parseRootCause(bodyText, res.status);
      if (!rootCause.fixFile) rootCause.fixFile = suggestedFixFile;
      return {
        name,
        url,
        passed: false,
        statusCode: res.status,
        rootCause,
        error: rootCause.detail,
        fixFile: suggestedFixFile,
        fixHint: rootCause.fixHint,
      };
    }

    // ── Success: extract data counts from response ─────────────────────────
    let dataFound = false;
    let recordCount: number | undefined;
    let responsePreview = '';

    if (ct.includes('json')) {
      try {
        const json = JSON.parse(bodyText);
        responsePreview = JSON.stringify(json).slice(0, 200);

        // Detect error responses disguised as HTTP 200
        // A route that returns {error: "Missing API key"} at status 200 is NOT passing.
        const isApiError =
          (typeof json.error === 'string' && json.error.length > 0) ||
          (typeof json.message === 'string' && /missing|not configured|invalid.*key|no.*provider|api.*key.*required|rapidapi|placeholder/i.test(json.message)) ||
          json.success === false ||
          json.ok === false;

        if (isApiError) {
          const errorDetail = (json.error || json.message || 'API returned error').slice(0, 200);
          const rootCause = parseRootCause(JSON.stringify(json), 200);
          // Check if this looks like a credentials issue
          if (/key|credential|rapidapi|provider|configured/i.test(errorDetail)) {
            rootCause.kind = 'route-failure';
            rootCause.detail = `API error: ${errorDetail}`;
            rootCause.fixHint = 'The route is reachable but the external API call failed. Check credentials and provider configuration.';
          }
          return {
            name,
            url,
            passed: false,
            statusCode: res.status,
            rootCause,
            error: `API error (HTTP 200): ${errorDetail}`,
            fixFile: suggestedFixFile,
            fixHint: rootCause.fixHint,
          };
        }

        const arr =
          (Array.isArray(json) && json) ||
          (Array.isArray(json.data) && json.data) ||
          (Array.isArray(json.items) && json.items) ||
          (Array.isArray(json.results) && json.results) ||
          (Array.isArray(json.properties) && json.properties) ||
          (Array.isArray(json.records) && json.records) ||
          null;

        if (arr) {
          dataFound = arr.length > 0;
          recordCount = arr.length;
        } else if (typeof json.count === 'number') {
          dataFound = json.count > 0;
          recordCount = json.count;
        } else if (json.success === true || json.ok === true) {
          dataFound = true;
        } else if (json.current_weather || json.weather || json.temperature !== undefined || json.temp !== undefined) {
          // Weather API specific — has data if current conditions present
          dataFound = true;
          recordCount = 1;
        } else if (Object.keys(json).length > 0) {
          // Non-empty object with real keys — treat as data present
          dataFound = true;
        }
      } catch {
        responsePreview = '(non-JSON body)';
      }
    } else {
      responsePreview = bodyText.slice(0, 200).replace(/\n/g, ' ');
      // ── Scaffold placeholder detection ──────────────────────────────────
      // The DWOMOH scaffold fallback serves a valid Next.js HTML page with HTTP 200
      // when Bedrock generation failed. We must NOT count this as a passing check.
      // The page text reveals it's still in "generating" state.
      for (const re of SCAFFOLD_PLACEHOLDER_PATTERNS) {
        if (re.test(bodyText)) {
          return {
            name,
            url,
            passed: false,
            statusCode: res.status,
            responsePreview,
            rootCause: {
              kind: 'scaffold-placeholder',
              detail: 'Preview is showing the AI generation placeholder ("Building your app…"). The real application has not rendered yet.',
              fixFile: 'app/page.tsx',
              fixHint: 'AI generation was incomplete. Trigger a re-generation with a stronger model or ask the user to retry the build.',
            },
            error: 'Scaffold placeholder detected — app has not rendered',
            fixFile: 'app/page.tsx',
            fixHint: 'Re-generate with Sonnet or Strongest model',
          };
        }
      }
      dataFound = true;
    }

    return {
      name,
      url,
      passed: true,
      statusCode: res.status,
      dataFound,
      recordCount,
      responsePreview,
    };

  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const rootCause: CheckRootCause = {
      kind: isAbort ? 'timeout' : 'runtime-crash',
      detail: isAbort ? 'Request timed out — handler may be hanging (no response in 10s)' : 'Connection refused — server not ready',
      fixFile: suggestedFixFile,
      fixHint: isAbort
        ? `Add a 5-second AbortController timeout to any fetch calls in ${suggestedFixFile ?? 'the handler'} and ensure it always returns a response`
        : undefined,
    };
    return {
      name,
      url,
      passed: false,
      rootCause,
      error: isAbort ? 'Timed out after 10s — handler hung' : err instanceof Error ? err.message : 'Request failed',
      fixFile: suggestedFixFile,
      fixHint: rootCause.fixHint,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function verifyRunningApp(
  port: number,
  apiRoutes: string[]
): Promise<VerificationResult> {
  const base = `http://localhost:${port}`;
  const checks: VerificationCheck[] = [];

  checks.push(await checkEndpoint(`${base}/`, 'Main page (GET /)'));

  const urlPaths = Array.from(
    new Set(
      apiRoutes
        .map(apiRouteFileToUrlPath)
        .filter((u): u is string => u !== null)
    )
  );

  for (const urlPath of urlPaths) {
    checks.push(await checkEndpoint(`${base}${urlPath}`, `API: GET ${urlPath}`));
  }

  const failures = checks
    .filter(c => !c.passed)
    .map(c => {
      const rc = c.rootCause;
      if (rc?.kind === 'missing-package' && rc.packages?.length) {
        return `${c.name}: missing package ${rc.packages.join(', ')}`;
      }
      return `${c.name}: ${c.error ?? `HTTP ${c.statusCode}`}`;
    });

  const verified = failures.length === 0;
  const passedCount = checks.filter(c => c.passed).length;

  const summary = verified
    ? `All ${checks.length} check(s) passed — app is running correctly.`
    : `${failures.length} of ${checks.length} check(s) failed (${passedCount} passed).`;

  return { verified, port, checks, failures, summary };
}

// ─── Health gate: blocks "verified" status when critical issues exist ─────────

export interface HealthGateResult {
  passes: boolean;
  blockers: string[];
}

/**
 * Never marks a project as Live/Verified/Healthy/Production Ready when:
 * - Any API route returns 4xx/5xx
 * - Required credentials are missing or placeholder
 * - Database connections fail
 * - Authentication is broken
 * - Critical functionality is unavailable
 */
export function healthGate(result: VerificationResult, missingCredentials?: string[]): HealthGateResult {
  const blockers: string[] = [];

  // Block on any HTTP failure
  for (const check of result.checks) {
    if (!check.passed) {
      const sc = check.statusCode;
      if (sc && (sc >= 400 || sc === 0)) {
        blockers.push(`${check.name} returned HTTP ${sc} — must be fixed before the app can be verified`);
      } else if (!sc) {
        blockers.push(`${check.name} is unreachable — server may not be running`);
      }
    }
  }

  // Block on missing credentials
  if (missingCredentials && missingCredentials.length > 0) {
    blockers.push(`Missing credentials: ${missingCredentials.join(', ')} — add these to .env.local`);
  }

  // Block on database errors
  const dbError = result.checks.find(c => !c.passed && c.rootCause?.kind === 'database-error');
  if (dbError) {
    blockers.push(`Database error in ${dbError.name} — fix before verifying`);
  }

  // Block on auth misconfiguration
  const authError = result.checks.find(c => !c.passed && c.rootCause?.kind === 'auth-misconfigured');
  if (authError) {
    blockers.push('Authentication is not configured — add NEXTAUTH_SECRET to .env.local');
  }

  return {
    passes: blockers.length === 0,
    blockers,
  };
}

export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [];
  for (const check of result.checks) {
    const icon = check.passed ? '✅' : '❌';
    const detail = check.passed
      ? check.recordCount !== undefined
        ? ` — ${check.recordCount} record(s) returned`
        : ''
      : ` — ${check.error ?? `HTTP ${check.statusCode}`}`;
    lines.push(`${icon} ${check.name}${detail}`);
  }
  return lines.join('\n');
}
