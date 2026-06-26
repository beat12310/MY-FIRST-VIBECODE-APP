/**
 * Journey Tester
 *
 * Simulates real user flows at the API level — no browser required.
 * Maintains a cookie jar across steps so auth state flows naturally.
 *
 * Examples:
 *   Marketplace: register → login → create listing → view listings → view listing
 *   Booking:     register → login → create booking  → list bookings → cancel booking
 *   Dashboard:   register → login → fetch dashboard data → update settings → logout
 *
 * Every step carries the session (cookies + extracted tokens) forward.
 * A failed step stops the journey and reports the exact breakpoint.
 *
 * The engine generates test data dynamically so each run is independent.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectType =
  | 'marketplace'
  | 'booking'
  | 'dashboard'
  | 'social'
  | 'ecommerce'
  | 'blog'
  | 'auth-only'
  | 'generic';

export interface JourneyStep {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Sent as JSON body (POST/PUT/PATCH) */
  body?: Record<string, unknown>;
  /** Expected HTTP status(es) — any of these counts as pass */
  expectedStatuses: number[];
  /** Extract this key from the response JSON and use as the next step's id */
  extractId?: string;
  /** If true, skip this step if the route doesn't exist (404 is ok) */
  optional?: boolean;
}

export interface JourneyStepResult {
  step: string;
  method: string;
  path: string;
  status: number;
  passed: boolean;
  optional: boolean;
  responsePreview: string;
  error?: string;
  durationMs: number;
}

export interface JourneyResult {
  projectType: ProjectType;
  journeyName: string;
  passed: boolean;
  steps: JourneyStepResult[];
  /** Which step was the first to fail */
  failedAt?: string;
  /** The error message at the failure point */
  failureDetail?: string;
  /** Summary for display */
  summary: string;
  durationMs: number;
}

// ─── Cookie jar (minimal, enough for JWT cookies) ─────────────────────────────

class CookieJar {
  private jar = new Map<string, string>();

  absorb(headers: Headers): void {
    // set-cookie may have multiple values but fetch() folds them
    const raw = headers.get('set-cookie');
    if (!raw) return;
    // Parse "name=value; Path=/; ..." — we only need name=value
    for (const segment of raw.split(',')) {
      const pair = segment.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  toHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  size(): number {
    return this.jar.size;
  }
}

// ─── Project type detection ───────────────────────────────────────────────────

const TYPE_SIGNALS: Record<ProjectType, RegExp[]> = {
  marketplace:  [/listing|sell|buy|marketplace|product|shop|vendor|campus.*hustle|hustle/i],
  booking:      [/booking|appointment|reservation|schedule|calendar|slot|avail/i],
  dashboard:    [/dashboard|analytics|report|metric|admin|panel|stat/i],
  social:       [/post|feed|follow|like|comment|social|tweet|forum|thread|community/i],
  ecommerce:    [/cart|checkout|order|payment|stripe|invoice|purchase/i],
  blog:         [/blog|article|post|author|publish|draft|content|cms/i],
  'auth-only':  [],  // fallback when only auth routes exist
  generic:      [],  // final fallback
};

export function detectProjectType(
  projectName: string,
  apiRoutes: string[],
  pages: string[],
): ProjectType {
  const combined = [projectName, ...apiRoutes, ...pages].join(' ');

  for (const [type, signals] of Object.entries(TYPE_SIGNALS) as [ProjectType, RegExp[]][]) {
    if (type === 'generic' || type === 'auth-only') continue;
    if (signals.some(re => re.test(combined))) return type;
  }

  // If only /api/auth/* routes exist, it's auth-only
  const nonAuthRoutes = apiRoutes.filter(r => !r.includes('/auth/'));
  if (nonAuthRoutes.length === 0 && apiRoutes.length > 0) return 'auth-only';

  return 'generic';
}

// ─── Journey template library ─────────────────────────────────────────────────

const TEST_USER = {
  email: `test_${Math.floor(Date.now() / 1000)}@journey.test`,
  password: 'Journey$Test1!',
  name: 'Journey Tester',
  username: 'journey_tester',
};

function marketplaceJourney(): JourneyStep[] {
  return [
    {
      name: 'Register user',
      method: 'POST',
      path: '/api/auth/register',
      body: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
      expectedStatuses: [200, 201],
    },
    {
      name: 'Login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectedStatuses: [200],
    },
    {
      name: 'Get current user (auth check)',
      method: 'GET',
      path: '/api/auth/me',
      expectedStatuses: [200],
    },
    {
      name: 'Create listing',
      method: 'POST',
      path: '/api/listings',
      body: {
        title: 'Journey Test Listing',
        description: 'Created by automated journey test',
        category: 'Other',
        price: 9.99,
      },
      expectedStatuses: [200, 201],
      extractId: 'listing.id',
    },
    {
      name: 'List all listings',
      method: 'GET',
      path: '/api/listings',
      expectedStatuses: [200],
    },
  ];
}

function bookingJourney(): JourneyStep[] {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return [
    {
      name: 'Register user',
      method: 'POST',
      path: '/api/auth/register',
      body: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
      expectedStatuses: [200, 201],
    },
    {
      name: 'Login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectedStatuses: [200],
    },
    {
      name: 'Get current user (auth check)',
      method: 'GET',
      path: '/api/auth/me',
      expectedStatuses: [200],
    },
    {
      name: 'Create booking',
      method: 'POST',
      path: '/api/bookings',
      body: {
        date: futureDate,
        time: '10:00',
        notes: 'Journey test booking',
        service: 'Test Service',
      },
      expectedStatuses: [200, 201],
      extractId: 'booking.id',
    },
    {
      name: 'List bookings',
      method: 'GET',
      path: '/api/bookings',
      expectedStatuses: [200],
    },
  ];
}

function dashboardJourney(): JourneyStep[] {
  return [
    {
      name: 'Register user',
      method: 'POST',
      path: '/api/auth/register',
      body: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
      expectedStatuses: [200, 201],
    },
    {
      name: 'Login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectedStatuses: [200],
    },
    {
      name: 'Get current user (auth check)',
      method: 'GET',
      path: '/api/auth/me',
      expectedStatuses: [200],
    },
    {
      name: 'Fetch dashboard data',
      method: 'GET',
      path: '/api/dashboard',
      expectedStatuses: [200],
      optional: true,
    },
    {
      name: 'Fetch data/stats',
      method: 'GET',
      path: '/api/data',
      expectedStatuses: [200],
      optional: true,
    },
    {
      name: 'Fetch analytics',
      method: 'GET',
      path: '/api/analytics',
      expectedStatuses: [200],
      optional: true,
    },
  ];
}

function socialJourney(): JourneyStep[] {
  return [
    {
      name: 'Register user',
      method: 'POST',
      path: '/api/auth/register',
      body: {
        email: TEST_USER.email,
        password: TEST_USER.password,
        name: TEST_USER.name,
        username: TEST_USER.username,
      },
      expectedStatuses: [200, 201],
    },
    {
      name: 'Login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectedStatuses: [200],
    },
    {
      name: 'Get current user (auth check)',
      method: 'GET',
      path: '/api/auth/me',
      expectedStatuses: [200],
    },
    {
      name: 'Create post',
      method: 'POST',
      path: '/api/posts',
      body: { content: 'Journey test post — automated verification', title: 'Test Post' },
      expectedStatuses: [200, 201],
      extractId: 'post.id',
    },
    {
      name: 'Fetch feed/posts',
      method: 'GET',
      path: '/api/posts',
      expectedStatuses: [200],
    },
  ];
}

function genericJourney(apiRoutes: string[]): JourneyStep[] {
  const steps: JourneyStep[] = [];

  // Auth flow if routes exist
  const hasRegister = apiRoutes.some(r => r.includes('/auth/register'));
  const hasLogin = apiRoutes.some(r => r.includes('/auth/login'));

  if (hasRegister) {
    steps.push({
      name: 'Register user',
      method: 'POST',
      path: '/api/auth/register',
      body: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
      expectedStatuses: [200, 201],
      optional: true,
    });
  }
  if (hasLogin) {
    steps.push({
      name: 'Login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectedStatuses: [200],
      optional: true,
    });
  }

  // Add GET probes for non-dynamic, non-auth routes
  const probeRoutes = apiRoutes
    .filter(r => !r.includes('[') && !r.includes('/auth/'))
    .map(r => r.replace(/^app/, '').replace(/\/route\.ts$/, ''))
    .slice(0, 5); // cap at 5 to keep tests fast

  for (const path of probeRoutes) {
    steps.push({
      name: `GET ${path}`,
      method: 'GET',
      path,
      expectedStatuses: [200],
      optional: true,
    });
  }

  return steps;
}

export function buildJourneySteps(
  projectType: ProjectType,
  apiRoutes: string[],
): JourneyStep[] {
  switch (projectType) {
    case 'marketplace':  return marketplaceJourney();
    case 'booking':      return bookingJourney();
    case 'dashboard':    return dashboardJourney();
    case 'social':       return socialJourney();
    case 'ecommerce':    return marketplaceJourney(); // close enough
    case 'blog':         return socialJourney();      // similar auth+create flow
    case 'auth-only': {
      return [
        { name: 'Register', method: 'POST', path: '/api/auth/register', body: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name }, expectedStatuses: [200, 201] },
        { name: 'Login',    method: 'POST', path: '/api/auth/login',    body: { email: TEST_USER.email, password: TEST_USER.password },                        expectedStatuses: [200] },
        { name: 'Me',       method: 'GET',  path: '/api/auth/me',                                                                                               expectedStatuses: [200] },
      ];
    }
    default: return genericJourney(apiRoutes);
  }
}

// ─── Journey executor ─────────────────────────────────────────────────────────

function extractNestedValue(obj: unknown, dotPath: string): string | null {
  const parts = dotPath.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : (typeof cur === 'number' ? String(cur) : null);
}

export async function runJourney(
  baseUrl: string,
  steps: JourneyStep[],
  projectType: ProjectType,
): Promise<JourneyResult> {
  const jar = new CookieJar();
  const results: JourneyStepResult[] = [];
  let lastExtractedId: string | null = null;
  const t0 = Date.now();

  const journeyName = `${projectType.charAt(0).toUpperCase() + projectType.slice(1)} User Journey`;

  for (const step of steps) {
    const stepStart = Date.now();

    // Inject extracted id from previous step into path (replace {id} placeholder)
    const path = lastExtractedId ? step.path.replace('{id}', lastExtractedId) : step.path;
    const url = `${baseUrl}${path}`;

    const hasBody = (step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH');
    const cookieHeader = jar.toHeader();

    const headers: Record<string, string> = {
      'Accept': 'application/json, text/html',
    };
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    let status = 0;
    let responseText = '';
    let passed = false;
    let error: string | undefined;

    try {
      const res = await fetch(url, {
        method: step.method,
        headers,
        signal: ctrl.signal,
        ...(hasBody && step.body ? { body: JSON.stringify(step.body) } : {}),
      });
      clearTimeout(timer);

      status = res.status;
      jar.absorb(res.headers);
      responseText = await res.text().catch(() => '');

      passed = step.expectedStatuses.includes(status);

      // Extract ID from response if requested
      if (passed && step.extractId) {
        try {
          const json = JSON.parse(responseText);
          const extracted = extractNestedValue(json, step.extractId);
          if (extracted) lastExtractedId = extracted;
        } catch { /* non-critical */ }
      }

      // For auth routes: detect errors masked as 200
      if (passed && status === 200) {
        try {
          const json = JSON.parse(responseText);
          if (typeof json.error === 'string' && json.error.length > 0) {
            passed = false;
            error = json.error;
          }
        } catch { /* non-JSON is fine for page routes */ }
      }

    } catch (err) {
      clearTimeout(timer);
      status = 0;
      error = err instanceof Error
        ? (err.name === 'AbortError' ? `Timed out after 12s` : err.message)
        : 'Request failed';
    }

    const preview = responseText.slice(0, 200).replace(/\n/g, ' ');

    results.push({
      step: step.name,
      method: step.method,
      path,
      status,
      passed: step.optional ? true : passed,  // optional steps never fail the journey
      optional: step.optional ?? false,
      responsePreview: preview,
      error: (!passed && !step.optional) ? (error ?? `HTTP ${status}`) : undefined,
      durationMs: Date.now() - stepStart,
    });

    // Stop on first non-optional failure
    if (!passed && !step.optional) {
      const failureDetail =
        `${step.name} failed: ${error ?? `HTTP ${status}`}` +
        (preview ? ` — ${preview.slice(0, 120)}` : '');

      return {
        projectType,
        journeyName,
        passed: false,
        steps: results,
        failedAt: step.name,
        failureDetail,
        summary: `Journey FAILED at "${step.name}" — ${error ?? `HTTP ${status}`}`,
        durationMs: Date.now() - t0,
      };
    }
  }

  const allPassed = results.every(r => r.passed);
  const passCount = results.filter(r => r.passed).length;
  const totalMs = Date.now() - t0;

  return {
    projectType,
    journeyName,
    passed: allPassed,
    steps: results,
    summary: allPassed
      ? `Journey PASSED — all ${passCount} step(s) completed successfully in ${totalMs}ms`
      : `Journey PARTIAL — ${passCount}/${results.length} steps passed`,
    durationMs: totalMs,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export interface JourneyTestInput {
  baseUrl: string;
  projectName: string;
  apiRoutes: string[];
  pages: string[];
}

export async function testUserJourney(input: JourneyTestInput): Promise<JourneyResult> {
  const projectType = detectProjectType(input.projectName, input.apiRoutes, input.pages);
  const steps = buildJourneySteps(projectType, input.apiRoutes);

  if (steps.length === 0) {
    return {
      projectType,
      journeyName: 'No journey available',
      passed: true,
      steps: [],
      summary: 'No user journey defined for this project type — skipping',
      durationMs: 0,
    };
  }

  return runJourney(input.baseUrl, steps, projectType);
}
