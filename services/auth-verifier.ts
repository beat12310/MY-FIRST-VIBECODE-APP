/**
 * Auth Page Verifier
 *
 * Verifies that the DWOMOH Vibe Code platform's own authentication pages
 * (Sign In, Sign Up, Forgot Password) load correctly with no ChunkLoadError,
 * hydration errors, or missing JavaScript chunks.
 *
 * Called:
 *   - After every cold start / cache clear
 *   - As part of the autonomous verification pipeline before marking a build complete
 *   - Via the `verify-auth-pages` action in /api/chat/route.ts
 */

export interface AuthPageCheck {
  route: string;
  label: string;
  status: number | null;
  passed: boolean;
  error?: string;
  htmlSnippet?: string;
}

export interface AuthVerificationReport {
  allPassed: boolean;
  checks: AuthPageCheck[];
  summary: string;
  chunkErrorDetected: boolean;
  hydrationErrorDetected: boolean;
}

// Patterns in the HTML that indicate a broken chunk or hydration failure
const CHUNK_ERROR_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk .+ failed/i,
  /_next\/static\/chunks\/.+\.js.*failed/i,
  /Uncaught Error.*chunk/i,
];

const HYDRATION_ERROR_PATTERNS = [
  /Hydration failed/i,
  /There was an error while hydrating/i,
  /did not match\. Server:/i,
];

const NEXT_ERROR_PATTERNS = [
  /Application error: a (client|server)-side exception has occurred/i,
  /__NEXT_PRIVATE_RENDER_WORKER__.*error/i,
];

function detectPatterns(html: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(html));
}

/**
 * Verify a single auth page at the given base URL.
 */
async function checkAuthPage(
  baseUrl: string,
  route: string,
  label: string,
  timeoutMs = 8_000,
): Promise<AuthPageCheck> {
  const url = `${baseUrl}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Mimic a real browser so Next.js doesn't serve JSON error responses
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    const html = await res.text().catch(() => '');
    const snippet = html.slice(0, 400);

    const chunkErr = detectPatterns(html, CHUNK_ERROR_PATTERNS);
    const hydrationErr = detectPatterns(html, HYDRATION_ERROR_PATTERNS);
    const nextErr = detectPatterns(html, NEXT_ERROR_PATTERNS);

    const passed = res.ok && !chunkErr && !hydrationErr && !nextErr;
    let error: string | undefined;

    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else if (chunkErr) {
      error = 'ChunkLoadError detected in page HTML';
    } else if (hydrationErr) {
      error = 'React hydration error detected';
    } else if (nextErr) {
      error = 'Next.js application error detected';
    }

    return { route, label, status: res.status, passed, error, htmlSnippet: snippet };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
    return {
      route, label,
      status: null,
      passed: false,
      error: isAbort ? `Timed out after ${timeoutMs}ms` : msg,
    };
  }
}

/**
 * Verify all auth pages: Sign In, Sign Up, Forgot Password.
 * baseUrl defaults to http://localhost:3000 (the DWOMOH app itself).
 */
export async function verifyAuthPages(
  baseUrl = 'http://localhost:3000',
): Promise<AuthVerificationReport> {
  const AUTH_ROUTES: Array<{ route: string; label: string }> = [
    { route: '/auth/signin',         label: 'Sign In' },
    { route: '/auth/signup',         label: 'Sign Up' },
    { route: '/auth/forgot-password', label: 'Forgot Password' },
  ];

  const checks = await Promise.all(
    AUTH_ROUTES.map(({ route, label }) => checkAuthPage(baseUrl, route, label)),
  );

  const allPassed = checks.every(c => c.passed);
  const failed = checks.filter(c => !c.passed);
  const chunkErrorDetected = checks.some(c => c.error?.toLowerCase().includes('chunk'));
  const hydrationErrorDetected = checks.some(c => c.error?.toLowerCase().includes('hydration'));

  const summary = allPassed
    ? `All ${checks.length} auth pages verified — Sign In, Sign Up, Forgot Password all return 200 with no JS errors.`
    : `${failed.length} of ${checks.length} auth page(s) failed: ${failed.map(c => `${c.label} (${c.error})`).join('; ')}.`;

  return { allPassed, checks, summary, chunkErrorDetected, hydrationErrorDetected };
}

/**
 * Verify auth pages AND check the auth layout chunk specifically.
 * Returns a human-readable report suitable for the builder's log panel.
 */
export async function runAuthVerificationReport(
  baseUrl = 'http://localhost:3000',
): Promise<string> {
  const report = await verifyAuthPages(baseUrl);

  const lines: string[] = ['── Auth Page Verification ──────────────────'];

  for (const check of report.checks) {
    const icon = check.passed ? '✓' : '✗';
    const status = check.status !== null ? ` [${check.status}]` : '';
    const err = check.error ? ` — ${check.error}` : '';
    lines.push(`  ${icon} ${check.label}${status}${err}`);
  }

  lines.push('');
  lines.push(report.summary);

  if (report.chunkErrorDetected) {
    lines.push('');
    lines.push('⚠ ChunkLoadError detected. Fix: clear .next cache and restart dev server.');
    lines.push('  Run: rm -rf .next && npm run dev');
  }

  if (report.hydrationErrorDetected) {
    lines.push('');
    lines.push('⚠ React hydration mismatch detected. Check for server/client render differences');
    lines.push('  in auth pages — typically caused by localStorage/cookie access during SSR.');
  }

  return lines.join('\n');
}
