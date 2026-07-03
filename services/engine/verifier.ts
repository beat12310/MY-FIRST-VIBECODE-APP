/**
 * DWOMOH VIBE CODE — Verifier Engine (Step 4).
 *
 * Judges whether a built project is actually usable and returns ONLY a VerifyResult.
 * It NEVER modifies files. Standalone: imports only the type contract; all I/O is
 * injected (a project-file reader + an optional HTTP probe), so every check —
 * structural, runtime, functional, performance, security, and internal-vs-external
 * classification — is unit-testable without a live server or Bedrock.
 *
 * When no probe is supplied, runtime/functional/performance/security checks record
 * 'skipped'/'not_applicable' (never a false pass) and `passed` stays false because
 * usability cannot be confirmed without a running app.
 */
import type {
  AppPlan, CapabilityId, ClassifiedFailure, ExternalService, ExternalServiceIssue,
  PerfMeasurement, PerfMetricName, PerformanceThresholds, SecurityCheck,
  VerifyResult, WorkflowKind, WorkflowStatus, WorkflowStep, WorkflowTest,
} from './types';
// The non-type imports in this otherwise standalone module: the Integration
// Registry (services/engine/integration-registry.ts) is the single source
// of truth for "does this generated feature have every wiring guarantee it
// needs" — middleware protection, API registration, navigation, dashboard
// widgets, breadcrumbs. Importing it here (rather than re-deriving each
// check inline) means every registered rule's detect() runs as part of
// static verification automatically; adding a new integration rule never
// requires touching this file. './integration-rules' is a side-effect
// import — it registers every concrete rule into the registry on load and
// exports nothing itself. Both modules are pure/dependency-free (no
// Bedrock, no I/O in detect()), so this doesn't compromise unit-testability.
import { detectIntegrationGaps, type IntegrationContext } from './integration-registry';
import './integration-rules';

// ── Injected I/O ──────────────────────────────────────────────────────────────
export interface ProbeRequest { method?: string; path: string; headers?: Record<string, string>; body?: string }
export interface ProbeResponse { status: number; body: string; ms: number; ok: boolean; error?: string }

export interface VerifierDeps {
  readProjectFiles: (projectPath: string) => Promise<{ path: string; content: string }[]>;
  /** Probe a URL relative to the preview. Absent → runtime checks are skipped. */
  probe?: (req: ProbeRequest) => Promise<ProbeResponse>;
  previewUrl?: string | null;
  thresholds?: PerformanceThresholds;
}

const DEFAULT_THRESHOLDS: Required<PerformanceThresholds> = {
  page_render: 3000, time_to_interactive: 5000, dashboard_load: 4000,
  login_response: 2000, search_response: 2000, api_latency: 1500,
};

// ── Internal vs external classification ──────────────────────────────────────
const EXTERNAL_SIGNATURES: { service: ExternalService; re: RegExp }[] = [
  { service: 'cognito', re: /cognito|user ?pool|not authorized exception/i },
  { service: 'bedrock', re: /bedrock|model (is )?(unavailable|not ready)|throttl/i },
  { service: 'paystack', re: /paystack/i },
  { service: 'stripe', re: /stripe/i },
  { service: 'mtn_momo', re: /mtn|momo|mobile money/i },
  { service: 'twilio', re: /twilio/i },
  { service: 'sendgrid', re: /sendgrid/i },
  { service: 'ses', re: /\bses\b|simple email service/i },
  { service: 'google_oauth', re: /google.*oauth|oauth.*google/i },
  { service: 'dynamodb', re: /dynamodb|provisionedthroughput/i },
];
const CODE_ERROR_RE = /TypeError|ReferenceError|SyntaxError|Cannot read|is not a function|is not defined|Module not found|Unexpected token|ECONNREFUSED 127\.0\.0\.1|ECONNREFUSED ::1/i;

/** Decide whether a runtime failure is the provider's fault (external) or ours (internal). */
export function classifyFailure(status: number, body: string): { origin: 'internal' | 'external' | 'unknown'; external?: ExternalServiceIssue } {
  for (const sig of EXTERNAL_SIGNATURES) {
    if (sig.re.test(body)) {
      return { origin: 'external', external: { service: sig.service, httpStatus: status, message: `${sig.service} reported an error (${status})`, transient: status === 0 || status >= 500 } };
    }
  }
  if (CODE_ERROR_RE.test(body)) return { origin: 'internal' };
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return { origin: 'external', external: { service: 'other', httpStatus: status, message: `Upstream/infra error ${status || 'timeout'}`, transient: true } };
  }
  if (status >= 500) return { origin: 'internal' };      // generic 500 from our handler
  return { origin: 'unknown' };
}

// ── Static structural analysis ───────────────────────────────────────────────
// Matches scaffold/stub pages the Builder emits when it runs out of real content:
//   - explicit "coming soon" / loading stubs, and
//   - the "Welcome to the <Route> page." one-liner scaffold (e.g. pricing/dashboard).
// The "welcome to the … page" clause is intentionally narrow ("the …/… page") so a
// legitimate hero like "Welcome to Bella Vista" is NOT flagged.
const PLACEHOLDER_RE = /coming soon|loading content…|loading content\.\.\.|the agent is generating|generating…|this page is coming soon|welcome to the [^<>{}\n]{1,40}? page/i;

/**
 * Cheap truncation/corruption detector for a generated code file. The Builder can
 * cut a file off mid-statement (a delimiter split or token limit), which the
 * previous static pass missed → the Verifier wrongly reported "0 build errors".
 *
 * We compare the count of `{` vs `}`. A truncated file (cut off mid-block) leaves
 * them unbalanced. Brace counting is deliberately raw: it is immune to the JSX
 * apostrophe problem (contractions like "Italy's" in JSX text) that breaks a
 * string-aware scanner, and braces inside string literals are vanishingly rare in
 * generated app code, so raw counting flags real truncation without false
 * positives on complete files.
 */
export function looksTruncated(content: string): boolean {
  const open = (content.match(/\{/g) || []).length;
  const close = (content.match(/\}/g) || []).length;
  return open !== close;
}

// Exported so other engine stages (Builder) can check "is this route present?"
// without re-deriving route-group-aware path parsing themselves.
export function fileToRoute(path: string): string | null {
  if (/^(?:src\/)?app\/page\.[jt]sx?$/.test(path)) return '/';
  const m = path.match(/^(?:src\/)?app\/(.*?)\/page\.[jt]sx?$/);
  if (!m) return null;
  const seg = m[1].replace(/\([^)]+\)\//g, '').replace(/\([^)]+\)$/, '').replace(/\/+$/, '');
  return seg ? '/' + seg : '/';
}
export const canon = (r: string) => r.replace(/\[[^\]]+\]/g, '[x]').replace(/\/+$/, '') || '/';

function resolveImport(spec: string, fromFile: string, fileSet: Set<string>): boolean {
  // Only resolve project-local imports; bare packages (react, next, …) are external.
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = fromFile.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') dir.pop(); else dir.push(part);
    }
    base = dir.join('/');
  } else return true; // external package — assume installed
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  return exts.some(e => fileSet.has(base + e));
}

interface StaticAnalysis {
  fileCount: number; routes: string[]; apiRoutes: string[]; pagesGenerated: number;
  deadLinks: string[]; brokenImports: string[]; missingExports: string[];
  placeholders: string[]; missingPlanned: string[]; buildErrors: string[];
  /**
   * Parallel to `placeholders`, but carries the ACTUAL matched forbidden phrase
   * per file — e.g. "welcome to the pricing page" or "coming soon" — so the
   * Repairer can quote it back to the model explicitly ("your content contains
   * this exact forbidden phrase") instead of restating the generic rule. Without
   * this, a repair retry sees only "this file is a placeholder" and can
   * regenerate content that trips the SAME pattern again with no more specific
   * guidance than the first attempt got.
   */
  placeholderMatches: { path: string; matched: string }[];
  /**
   * A page/component calling fetch('/api/X') where /api/X is neither an
   * EXISTING route file nor a PLANNED one. missingPlanned only catches files
   * the plan declared but the model never wrote; this catches the model
   * inventing a data dependency it never declared as a route at all —
   * confirmed live on a FRESH build that passed every other check: a
   * dashboard page called /api/dashboard/stats, list pages called
   * /api/suppliers and /api/products/[id], none of which existed anywhere —
   * fully broken data flow that the pre-existing brokenImports check (ES
   * imports only) could never see.
   */
  orphanedApiCalls: string[];
  /**
   * A page that SHOULD require a session (per the same public-route
   * exclusion heuristic auth-template.ts uses to build middleware.ts's
   * PROTECTED_PATTERNS in the first place) but middleware.ts doesn't cover
   * it. builder.ts regenerates middleware.ts once the initial file set is
   * final, but a page created LATER — e.g. by the repair stage's dead-link
   * fast-path, which runs after that regeneration — can still slip through
   * uncovered. This is the self-healing backstop: whenever and however a
   * protected-seeming page appears, verify catches it and repair closes it.
   */
  unprotectedRoutes: string[];
  /** A non-public top-level page missing from Navbar/Footer/Sidebar. Integration Registry rule "navigation". */
  navigationGaps: string[];
  /** An existing API resource with no corresponding dashboard stat widget. Integration Registry rule "dashboard-widgets". */
  dashboardWidgetGaps: string[];
  /** A dynamic detail page ([id]) with no breadcrumb trail. Integration Registry rule "breadcrumbs". */
  breadcrumbGaps: string[];
  /** A role-gated route section (e.g. /admin) with no enforcing ROLE_PATTERNS entry in middleware.ts. Integration Registry rule "permissions". */
  permissionGaps: string[];
  /** A missing/mismatched table, column, or foreign key (compared against every query that references it). Integration Registry rule "database-schema". */
  databaseSchemaGaps: string[];
  /** A table queried by a search-named route with no FTS5 index yet. Integration Registry rule "search-indexing". */
  searchIndexGaps: string[];
  /** A notifications feature present with no lib/managed/notifications.ts service. Integration Registry rule "notifications". */
  notificationsGaps: string[];
}

export function analyzeStatic(plan: AppPlan, files: { path: string; content: string }[]): StaticAnalysis {
  const fileSet = new Set(files.map(f => f.path));
  const code = files.filter(f => /\.(tsx?|jsx?)$/.test(f.path));
  const routes: string[] = [], apiRoutes: string[] = [];
  const pageSet = new Set<string>();
  for (const f of files) {
    const r = fileToRoute(f.path);
    if (r) { routes.push(r); pageSet.add(canon(r)); }
    if (/^(?:src\/)?app\/api\/.*route\.[jt]sx?$/.test(f.path)) apiRoutes.push('/' + f.path.replace(/^(?:src\/)?app\//, '').replace(/\/route\.[jt]sx?$/, ''));
  }

  // referenced internal routes with no page
  const referenced = new Set<string>();
  const refPats = [/href\s*=\s*["'`](\/[^"'`?#${[]*)/g, /href:\s*["'`](\/[^"'`?#${[]*)/g, /router\.push\(\s*["'`](\/[^"'`?#${[]*)/g];
  for (const f of code) for (const re of refPats) { let m; while ((m = re.exec(f.content))) { const r = m[1].replace(/\/+$/, '') || '/'; if (!r.startsWith('/api')) referenced.add(r); } }
  const deadLinks = [...referenced].filter(r => !pageSet.has(canon(r))).sort();

  // broken imports + missing exports + placeholders + truncation
  const brokenImports: string[] = [], missingExports: string[] = [], placeholders: string[] = [];
  const placeholderMatches: { path: string; matched: string }[] = [];
  const truncatedFiles: string[] = [];
  const importRe = /import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;
  for (const f of code) {
    let m; while ((m = importRe.exec(f.content))) { if (!resolveImport(m[1], f.path, fileSet)) brokenImports.push(`${f.path} → ${m[1]}`); }
    if (/\/page\.[jt]sx?$/.test(f.path) && !/export\s+default/.test(f.content)) missingExports.push(f.path);
    if (/\/route\.[jt]sx?$/.test(f.path) && !/export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)/.test(f.content)) missingExports.push(f.path);
    const placeholderHit = f.content.match(PLACEHOLDER_RE);
    if (placeholderHit) { placeholders.push(f.path); placeholderMatches.push({ path: f.path, matched: placeholderHit[0] }); }
    if (looksTruncated(f.content)) truncatedFiles.push(f.path);
  }

  // Integration Registry — runs every applicable rule's detect() (API
  // registration, middleware protection, navigation, dashboard widgets,
  // breadcrumbs; core-vs-optional gating handled by each rule's appliesTo())
  // against one shared context, then buckets the results back into the
  // StaticAnalysis fields the rest of this file already expects. The
  // detection ALGORITHMS themselves now live in integration-rules.ts (moved,
  // not duplicated, from what used to be inline here) — this is the single
  // place they run.
  const integrationCtx: IntegrationContext = { plan, files, fileSet, routes: [...new Set(routes)], apiRoutes: [...new Set(apiRoutes)] };
  const gaps = detectIntegrationGaps(integrationCtx);
  const orphanedApiCalls = gaps.filter(g => g.integrationId === 'api-registration').map(g => g.detail);
  const unprotectedRoutes = gaps.filter(g => g.integrationId === 'middleware-protection')
    .map(g => g.detail.match(/^Unprotected route (\S+) /)?.[1]).filter((r): r is string => !!r);
  const navigationGaps = gaps.filter(g => g.integrationId === 'navigation').map(g => g.detail);
  const dashboardWidgetGaps = gaps.filter(g => g.integrationId === 'dashboard-widgets').map(g => g.detail);
  const breadcrumbGaps = gaps.filter(g => g.integrationId === 'breadcrumbs').map(g => g.detail);
  const permissionGaps = gaps.filter(g => g.integrationId === 'permissions').map(g => g.detail);
  const databaseSchemaGaps = gaps.filter(g => g.integrationId === 'database-schema').map(g => g.detail);
  const searchIndexGaps = gaps.filter(g => g.integrationId === 'search-indexing').map(g => g.detail);
  const notificationsGaps = gaps.filter(g => g.integrationId === 'notifications').map(g => g.detail);

  // planned vs actual — pages are matched by RESOLVED ROUTE (pageSet, built above via
  // fileToRoute), not literal file path, so a page the model placed inside a route
  // group (e.g. app/(marketing)/about/page.tsx) is correctly recognized as present.
  // API routes don't carry the same route-group ambiguity, so they stay exact-path.
  const missingPlannedPages = plan.pages.filter(p => !pageSet.has(canon(p.route))).map(p => p.filePath);
  const missingPlannedApi = plan.apiRoutes.filter(r => !fileSet.has(r.filePath)).map(r => r.filePath);
  const missingPlanned = [...missingPlannedPages, ...missingPlannedApi];

  const buildErrors: string[] = [];
  if (!pageSet.has('/')) buildErrors.push('Missing root page app/page.tsx');
  // Truncated/corrupt files are hard build failures — a Next compile of the route
  // will throw. These MUST surface (the old pass reported "0 build errors" for them).
  truncatedFiles.forEach(fp => buildErrors.push(`Truncated/unbalanced file (incomplete generation): ${fp}`));

  return {
    fileCount: files.length, routes: [...new Set(routes)].sort(), apiRoutes: [...new Set(apiRoutes)].sort(),
    pagesGenerated: pageSet.size, deadLinks, brokenImports, missingExports, placeholders, placeholderMatches, missingPlanned, buildErrors, orphanedApiCalls, unprotectedRoutes,
    navigationGaps, dashboardWidgetGaps, breadcrumbGaps, permissionGaps, databaseSchemaGaps, searchIndexGaps, notificationsGaps,
  };
}

// ── Runtime helpers ───────────────────────────────────────────────────────────
const step = (action: string, expectation: string, ok: boolean, observed?: string): WorkflowStep => ({ action, expectation, ok, observed });

async function runWorkflows(plan: AppPlan, deps: VerifierDeps, externalIssues: ExternalServiceIssue[], signal?: AbortSignal): Promise<WorkflowTest[]> {
  if (!deps.probe || signal?.aborted) return [];
  const probe = deps.probe;
  const tests: WorkflowTest[] = [];

  const finish = (kind: WorkflowKind, label: string, target: string, steps: WorkflowStep[], rawStatus: number, rawBody: string): WorkflowTest => {
    const failed = steps.some(s => !s.ok);
    let status: WorkflowStatus = failed ? 'failed' : 'passed';
    let failureOrigin: WorkflowTest['failureOrigin'];
    if (failed) {
      const cls = classifyFailure(rawStatus, rawBody);
      failureOrigin = cls.origin;
      if (cls.external) externalIssues.push(cls.external);
    }
    return { kind, label, target, status, steps, failureOrigin };
  };

  if (plan.requiresAuth) {
    // Unique per call, not a fixed address — runWorkflows runs on EVERY verify
    // pass (static passes skip it for lack of a probe, but every runtime pass
    // re-runs it) against the SAME persistent SQLite database. A fixed test
    // email only succeeds on the very first pass; every later pass legitimately
    // gets "already registered" (409) and reports a false auth_signup failure
    // — confirmed live: a genuinely correct register route still showed
    // auth_signup=failed on a re-verify because the account already existed
    // from the prior pass. name is included because the standard register
    // contract (auth-template.ts, and most real signup forms) requires it.
    const testEmail = `v+${Date.now()}${Math.floor(Math.random() * 10000)}@test.dev`;
    let r = await probe({ method: 'POST', path: '/api/auth/register', body: JSON.stringify({ name: 'Test User', email: testEmail, password: 'Passw0rd!' }) });
    tests.push(finish('auth_signup', 'User signup', '/api/auth/register', [step('POST /api/auth/register', '2xx', r.status >= 200 && r.status < 300, `HTTP ${r.status}`)], r.status, r.body));
    r = await probe({ method: 'POST', path: '/api/auth/login', body: JSON.stringify({ email: testEmail, password: 'Passw0rd!' }) });
    tests.push(finish('auth_login', 'User login', '/api/auth/login', [step('POST /api/auth/login', '2xx + session', r.status >= 200 && r.status < 300, `HTTP ${r.status}`)], r.status, r.body));
    const prot = await probe({ path: '/dashboard' });
    const ok = prot.status === 401 || prot.status === 302 || prot.status === 307 || /sign in|login/i.test(prot.body);
    tests.push(finish('auth_protected_access', 'Protected route blocks anonymous', '/dashboard', [step('GET /dashboard (no auth)', '401/redirect', ok, `HTTP ${prot.status}`)], prot.status, prot.body));
  }

  // CRUD on the first resource API route
  const resourceApi = plan.apiRoutes.find(r => /^\/api\/[a-z0-9-]+$/i.test(r.route));
  if (resourceApi) {
    const base = resourceApi.route;
    const c = await probe({ method: 'POST', path: base, body: JSON.stringify({ title: 'x' }) });
    tests.push(finish('crud_create', `Create ${base}`, base, [step(`POST ${base}`, '2xx', c.status >= 200 && c.status < 300, `HTTP ${c.status}`)], c.status, c.body));
    const list = await probe({ path: base });
    tests.push(finish('crud_read', `List ${base}`, base, [step(`GET ${base}`, '2xx', list.status >= 200 && list.status < 300, `HTTP ${list.status}`)], list.status, list.body));
  }

  // API response health for each api route
  for (const r of plan.apiRoutes.slice(0, 6)) {
    const resp = await probe({ path: r.route });
    tests.push(finish('api_response', `API responds ${r.route}`, r.route, [step(`GET ${r.route}`, 'non-5xx', resp.status < 500, `HTTP ${resp.status}`)], resp.status, resp.body));
  }

  // search if applicable
  if (plan.capabilities.includes('analytics') || /search/i.test(plan.description)) {
    const s = await probe({ path: '/api/search?q=test' });
    tests.push(finish('search', 'Search responds', '/api/search', [step('GET /api/search?q=test', 'non-5xx', s.status < 500, `HTTP ${s.status}`)], s.status, s.body));
  }

  // deployment dry-run (never a real deploy here)
  tests.push({ kind: 'deployment', label: 'Deployment dry-run', target: '(dry-run)', status: 'skipped', steps: [step('dry-run', 'no real deploy in verifier', true, 'skipped')] });

  return tests;
}

async function runPerformance(plan: AppPlan, deps: VerifierDeps, signal?: AbortSignal): Promise<PerfMeasurement[]> {
  if (!deps.probe || signal?.aborted) return [];
  const t = { ...DEFAULT_THRESHOLDS, ...(deps.thresholds ?? {}) };
  const probe = deps.probe;
  const out: PerfMeasurement[] = [];
  const measure = async (metric: PerfMetricName, req: ProbeRequest) => {
    const r = await probe(req);
    out.push({ metric, target: req.path, valueMs: r.ms, thresholdMs: t[metric], withinBudget: r.ms <= t[metric] });
  };
  await measure('page_render', { path: '/' });
  if (plan.pages.some(p => p.route === '/dashboard')) await measure('dashboard_load', { path: '/dashboard' });
  if (plan.requiresAuth) await measure('login_response', { method: 'POST', path: '/api/auth/login', body: '{}' });
  const api = plan.apiRoutes[0];
  if (api) await measure('api_latency', { path: api.route });
  return out;
}

async function runSecurity(plan: AppPlan, deps: VerifierDeps, signal?: AbortSignal): Promise<SecurityCheck[]> {
  if (!deps.probe || signal?.aborted) return [];
  const probe = deps.probe;
  const checks: SecurityCheck[] = [];
  if (plan.requiresAuth) {
    const prot = await probe({ path: '/dashboard' });
    const blocks = prot.status === 401 || prot.status === 302 || prot.status === 307 || /sign in|login/i.test(prot.body);
    checks.push({ kind: 'protected_route_requires_auth', label: 'Protected page requires auth', severity: 'critical', target: '/dashboard', status: blocks ? 'passed' : 'failed', detail: `HTTP ${prot.status}` });

    // Only test endpoints that SHOULD be protected — a public list endpoint
    // legitimately returns 200 to anonymous users and must not be failed for it.
    const protApi = plan.apiRoutes.find(r => /dashboard|account|\/me\b|orders|profile|admin|settings/i.test(r.route));
    if (protApi) {
      const r = await probe({ path: protApi.route, headers: {} });
      const rejects = r.status === 401 || r.status === 403;
      checks.push({ kind: 'api_rejects_unauthorized', label: 'Protected API rejects unauthorized', severity: 'critical', target: protApi.route, status: rejects ? 'passed' : (r.status >= 200 && r.status < 300 ? 'failed' : 'not_applicable'), detail: `HTTP ${r.status}` });
    } else {
      checks.push({ kind: 'api_rejects_unauthorized', label: 'Protected API rejects unauthorized', severity: 'critical', target: '(no protected API endpoint detected)', status: 'not_applicable' });
    }
    const bad = await probe({ path: '/api/auth/login', method: 'POST', headers: { authorization: 'Bearer invalid.token' }, body: '{}' });
    checks.push({ kind: 'session_token_verification', label: 'Invalid token rejected', severity: 'high', target: '/api/auth/login', status: (bad.status === 401 || bad.status === 400) ? 'passed' : 'failed', detail: `HTTP ${bad.status}` });
  }
  // input validation: malformed create should be 4xx, not 500
  const resourceApi = plan.apiRoutes.find(r => /^\/api\/[a-z0-9-]+$/i.test(r.route));
  if (resourceApi) {
    const r = await probe({ method: 'POST', path: resourceApi.route, body: 'not-json' });
    checks.push({ kind: 'input_validation', label: 'Malformed input rejected (4xx, not 500)', severity: 'high', target: resourceApi.route, status: (r.status >= 400 && r.status < 500) ? 'passed' : (r.status >= 500 ? 'failed' : 'not_applicable'), detail: `HTTP ${r.status}` });
  }
  // user isolation + authorization need two seeded users — declared but not auto-runnable here
  checks.push({ kind: 'cross_user_data_isolation', label: 'User cannot read another user’s data', severity: 'critical', target: '(needs two seeded users)', status: 'skipped' });
  checks.push({ kind: 'authorization_enforced', label: 'Role/authorization enforced', severity: 'high', target: '(needs role fixtures)', status: 'skipped' });
  return checks;
}

// ── Orchestrated verification ─────────────────────────────────────────────────
export async function verifyApp(plan: AppPlan, projectPath: string, deps: VerifierDeps, signal?: AbortSignal): Promise<VerifyResult> {
  const files = await deps.readProjectFiles(projectPath);
  const s = analyzeStatic(plan, files);

  const classifiedFailures: ClassifiedFailure[] = [];
  const addInternal = (area: ClassifiedFailure['area'], detail: string, integrationId?: string) =>
    classifiedFailures.push({ origin: 'internal', area, detail, repairable: true, integrationId });
  s.buildErrors.forEach(d => addInternal('structural', d));
  s.missingPlanned.forEach(d => addInternal('structural', `Planned file missing: ${d}`));
  s.deadLinks.forEach(d => addInternal('runtime', `Dead link / 404 risk: ${d}`));
  s.brokenImports.forEach(d => addInternal('structural', `Broken import: ${d}`));
  s.missingExports.forEach(d => addInternal('structural', `Missing export: ${d}`));
  s.orphanedApiCalls.forEach(d => addInternal('structural', `Orphaned API call: ${d}`, 'api-registration'));
  // The route MUST stay right before the trailing "middleware.ts" — repairer.ts's
  // fast-path extracts it via a regex, and describeTarget() separately relies
  // on the string ending in a real file path (middleware.ts), matching the
  // convention every other failure-detail message in this file uses.
  s.unprotectedRoutes.forEach(r => addInternal('security', `Unprotected route ${r} — middleware.ts does not cover it: middleware.ts`, 'middleware-protection'));
  // Integration Registry gaps — navigation/dashboard-widgets are UX/discovery
  // concerns (a working but unlinked page), not build-breaking, so they're
  // classified 'runtime' rather than 'structural'; breadcrumbs likewise.
  s.navigationGaps.forEach(d => addInternal('runtime', d, 'navigation'));
  s.dashboardWidgetGaps.forEach(d => addInternal('runtime', d, 'dashboard-widgets'));
  s.breadcrumbGaps.forEach(d => addInternal('runtime', d, 'breadcrumbs'));
  s.permissionGaps.forEach(d => addInternal('security', d, 'permissions'));
  s.databaseSchemaGaps.forEach(d => addInternal('structural', d, 'database-schema'));
  s.searchIndexGaps.forEach(d => addInternal('runtime', d, 'search-indexing'));
  s.notificationsGaps.forEach(d => addInternal('runtime', d, 'notifications'));
  // The file path MUST stay at the end of the detail string — repairer.ts's
  // describeTarget() extracts the target file via a regex anchored on `$`,
  // matching the convention every other failure-detail message in this file uses.
  s.placeholderMatches.forEach(d => addInternal('runtime', `Placeholder/infinite-loading page (forbidden phrase found: "${d.matched}"): ${d.path}`));

  const externalIssues: ExternalServiceIssue[] = [];

  // Runtime
  let previewLoads: boolean | null = null;
  const notFoundRoutes: string[] = [];
  if (deps.probe && deps.previewUrl && !signal?.aborted) {
    const home = await deps.probe({ path: '/' });
    // Status code is the authoritative signal here, NOT a body-content search
    // for "404"/"not found" — Next.js App Router embeds a serialized reference
    // to its own default not-found page ("404: This page could not be found")
    // in the RSC/flight payload of EVERY page's response (client-side
    // prefetch/error-boundary metadata), so that substring is present even on
    // a perfectly healthy 200 response. Confirmed live: a real HTTP 200 home
    // page's body contained that exact string as framework boilerplate, which
    // made previewLoads permanently false for every single generated app.
    const isScaffold = PLACEHOLDER_RE.test(home.body);
    previewLoads = home.status >= 200 && home.status < 400 && !isScaffold;
    if (!previewLoads) {
      const cls = classifyFailure(home.status, home.body);
      if (cls.origin === 'external' && cls.external) externalIssues.push(cls.external);
      else addInternal('runtime', `Preview did not load (HTTP ${home.status})`);
    }
    for (const r of s.routes) {
      if (signal?.aborted) break; // stop probing remaining routes once cancelled
      const resp = await deps.probe({ path: r });
      if (resp.status === 404) { notFoundRoutes.push(r); addInternal('runtime', `Route 404: ${r}`); }
    }
  }

  const workflowTests = await runWorkflows(plan, deps, externalIssues, signal);
  const performance = await runPerformance(plan, deps, signal);
  const securityChecks = await runSecurity(plan, deps, signal);

  // record internal workflow failures as classified failures
  for (const w of workflowTests) if (w.status === 'failed' && w.failureOrigin !== 'external') addInternal('functional', `Workflow failed: ${w.label}`);
  for (const sec of securityChecks) {
    if (sec.status !== 'failed' || sec.severity !== 'critical') continue;
    // api_rejects_unauthorized's target is an API ROUTE ("/api/orders"), not a
    // file path — resolve it to the actual route file so describeTarget() in
    // repairer.ts can extract a fixable target (its regex requires the detail
    // to END in a real file path). Without this, the failure carried no
    // actionable location at all, and a fast-path match on the generic label
    // alone would silently "resolve" it by touching unrelated auth files that
    // structurally can't fix a business API route's own auth check.
    const apiFilePath = sec.kind === 'api_rejects_unauthorized'
      ? plan.apiRoutes.find(r => r.route === sec.target)?.filePath
      : undefined;
    addInternal('security', apiFilePath ? `Security failed: ${sec.label}: ${apiFilePath}` : `Security failed: ${sec.label}`);
  }
  for (const perf of performance) if (!perf.withinBudget) addInternal('performance', `Over budget: ${perf.metric} ${perf.valueMs}ms > ${perf.thresholdMs}ms`);

  const workflowsPassed = workflowTests.every(w => w.status !== 'failed' || w.failureOrigin === 'external');
  const performanceWithinBudget = performance.every(p => p.withinBudget);
  const securityPassed = securityChecks.filter(c => c.severity === 'critical').every(c => c.status !== 'failed');

  const structuralOK = s.buildErrors.length === 0 && s.missingPlanned.length === 0 && s.deadLinks.length === 0
    && s.brokenImports.length === 0 && s.missingExports.length === 0 && s.placeholders.length === 0
    && s.orphanedApiCalls.length === 0;
  const noInternalFailures = !classifiedFailures.some(f => f.origin === 'internal');

  const passed = structuralOK && previewLoads === true && workflowsPassed
    && performanceWithinBudget && securityPassed && noInternalFailures;

  return {
    fileCount: s.fileCount, routes: s.routes, apiRoutes: s.apiRoutes, pagesGenerated: s.pagesGenerated,
    deadLinks: s.deadLinks, notFoundRoutes, brokenImports: s.brokenImports,
    buildErrors: [...s.buildErrors, ...s.missingExports.map(e => `Missing export: ${e}`), ...s.orphanedApiCalls.map(e => `Orphaned API call: ${e}`)],
    previewUrl: deps.previewUrl ?? null, previewLoads,
    workflowTests, workflowsPassed,
    externalIssues, classifiedFailures,
    performance, performanceWithinBudget,
    securityChecks, securityPassed,
    passed,
  };
}
