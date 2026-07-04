/**
 * DWOMOH VIBE CODE — Generation Engine contracts.
 *
 * PURE TYPES ONLY. No imports of runtime modules, no logic, no side effects.
 * Nothing imports this file yet — it defines the data model the rebuilt engine
 * (Planner → Builder → Verifier → Repairer → Learner) will share once wired.
 *
 * Stage data flow:
 *   Prompt ──Planner──▶ AppPlan ──Builder──▶ BuildResult
 *          ──Verifier──▶ VerifyResult ──Repairer──▶ RepairResult
 *          ──Learner──▶ (persisted patterns) ──▶ EngineReport
 */

// ── Capability identifiers (services an app may need) ────────────────────────
export type CapabilityId =
  | 'payments' | 'auth' | 'database' | 'email' | 'sms' | 'maps' | 'seo'
  | 'ai_text' | 'ai_image' | 'ai_video' | 'storage' | 'analytics'
  | 'domains' | 'deployment' | 'notifications';

/** How a capability is fulfilled for a given project. */
export type ProviderMode = 'platform' | 'byok' | 'free';

/** Channels a first-class Notifications capability can deliver over. */
export type NotificationChannel =
  | 'push' | 'email' | 'sms' | 'whatsapp' | 'slack' | 'discord' | 'webhook';

/** Static (declared) provider health; live status is resolved at runtime later. */
export type ProviderHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

// ── Configurable pricing ──────────────────────────────────────────────────────
// Prices are NOT hardcoded as the source of truth. Each capability declares a
// config key the engine resolves at runtime (DB / Parameter Store / env). The
// `defaultCredits` is a fallback used ONLY when no configured value is found.
export type PricingUnit = 'per_call' | 'per_1k_tokens' | 'per_minute' | 'per_image' | 'per_video';

export interface CreditPricing {
  /** Key the engine looks up in external config (e.g. 'pricing.ai_video'). */
  configKey: string;
  /** Fallback charge if config has no value. Not a fixed price of record. */
  defaultCredits: number;
  unit: PricingUnit;
}

// ── App classification ────────────────────────────────────────────────────────
export type AppType =
  | 'ecommerce' | 'marketplace' | 'booking' | 'saas' | 'social' | 'blog'
  | 'portfolio' | 'landing' | 'dashboard' | 'media' | 'education'
  | 'real_estate' | 'restaurant' | 'fintech'
  // Tool-shaped apps — small/single-purpose, distinct from content/business apps above:
  | 'downloader'    // video/audio/content downloader & converter tools
  | 'utility'       // calculators, generators, formatters, validators, converters
  | 'media_tool'    // image/video/audio processing tools (compress, edit, convert)
  | 'browser_tool'  // in-browser dev/productivity tools (JSON viewer, regex tester, etc.)
  | 'ai_assistant'  // AI chat/assistant/chatbot apps
  // Multi-category support — an app need not fit a single bucket:
  | 'hybrid'        // intentionally combines several types (e.g. marketplace + booking)
  | 'multi_domain'  // multiple distinct sub-apps under one project
  | 'custom'        // bespoke, planner derives capabilities directly
  | 'unknown';      // could not be classified — planner uses conservative defaults

export interface DetectedIntent {
  /** Primary classification. */
  appType: AppType;
  /** Additional types whose profiles should be MERGED (hybrid / multi-domain). */
  secondaryTypes: AppType[];
  /** 0..1 — confidence of the classification. */
  confidence: number;
  /** Human-readable label shown to the user before building. */
  label: string;
  /**
   * How the type was decided. Precedence when the Planner is fully wired:
   *   memory (existing project) > model (LLM classification) > keyword > fallback.
   */
  source: 'memory' | 'model' | 'keyword' | 'fallback';
}

// ── AppPlan: the full internal blueprint produced by the Planner ─────────────
export interface PlannedPage {
  route: string;            // URL route, e.g. "/" or "/products/[id]"
  filePath: string;         // app/.../page.tsx
  title: string;
  purpose: string;
  dynamic?: boolean;        // true for [id]/[slug] routes
}

export interface PlannedApiRoute {
  route: string;            // /api/...
  filePath: string;
  methods: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
  purpose: string;
}

export interface PlannedComponent {
  name: string;
  filePath: string;
  purpose: string;
}

export interface PlannedDataModel {
  name: string;
  fields: { name: string; type: string }[];
}

export interface UiStyle {
  preset: 'classic' | 'modern' | 'premium-3d' | 'mobile-first' | 'minimal';
  palette: string[];        // hex values
  animations: boolean;
}

/**
 * Capability versioning: a capability is pinned to a provider + version +
 * configuration so existing projects don't break when a provider updates its API.
 * This shape is also persisted to Project Memory.
 */
export interface ResolvedCapability {
  capability: CapabilityId;
  provider: string;
  /** Provider API version this project was built against. */
  version: string;
  /** Resolved, non-secret config (proxy path, options) — never raw keys. */
  configuration: Record<string, unknown>;
}

export interface AppPlan {
  projectName: string;      // slug-safe
  displayName: string;
  description: string;
  intent: DetectedIntent;
  pages: PlannedPage[];
  apiRoutes: PlannedApiRoute[];
  components: PlannedComponent[];
  dataModels: PlannedDataModel[];
  requiresAuth: boolean;
  seo: { sitemap: boolean; robots: boolean; metadata: boolean; schema: boolean };
  uiStyle: UiStyle;
  /** Capabilities this app needs (ids). */
  capabilities: CapabilityId[];
  /** Capabilities resolved to provider + version + config (filled at wiring). */
  resolvedCapabilities: ResolvedCapability[];
}

// ── BuildResult: what the Builder actually wrote to disk ─────────────────────
export interface GeneratedFile { path: string; bytes: number; }

export interface BuildResult {
  projectPath: string;       // absolute path of the FRESH project folder
  isFreshFolder: boolean;    // true only if the folder was newly created this build
  filesCreated: GeneratedFile[];
  foldersCreated: number;
  startedAt: string;
  finishedAt: string;
  /** Whether the AI output had to be recovered from a non-strict (markdown) response. */
  recoveredFromLooseFormat: boolean;
  logs: string[];
}

// ── Functional workflow tests (runtime) ─────────────────────────────────────
// Exercise the running app/API — not just file existence. The test matrix is
// derived from the AppPlan (auth → login/signup; dataModels → CRUD; apiRoutes →
// api_response; etc.). When no server is available they record 'skipped'/'n_a'
// rather than a false pass.
export type WorkflowKind =
  | 'auth_signup' | 'auth_login' | 'auth_protected_access'
  | 'form_submit' | 'search'
  | 'crud_create' | 'crud_read' | 'crud_update' | 'crud_delete'
  | 'api_response' | 'deployment';

export type WorkflowStatus = 'passed' | 'failed' | 'skipped' | 'not_applicable';

export interface WorkflowStep {
  action: string;       // e.g. "POST /api/auth/login with seeded user"
  expectation: string;  // e.g. "200 + session cookie"
  observed?: string;    // what actually happened
  ok: boolean;
}

export interface WorkflowTest {
  kind: WorkflowKind;
  label: string;
  target: string;       // route or endpoint exercised
  status: WorkflowStatus;
  steps: WorkflowStep[];
  durationMs?: number;
  error?: string;
  /** Set when status==='failed' so the Repairer knows whether to act (see below). */
  failureOrigin?: FailureOrigin;
}

// ── 1. External dependency awareness ─────────────────────────────────────────
// Distinguish OUR bugs (repairable) from third-party outages (report, don't
// regenerate). A Cognito 503 must NOT trigger login-code regeneration.
export type FailureOrigin = 'internal' | 'external' | 'unknown';

export type ExternalService =
  | 'cognito' | 'bedrock' | 'supabase' | 'stripe' | 'paystack' | 'mtn_momo'
  | 'google_oauth' | 'twilio' | 'sendgrid' | 'ses' | 'route53' | 's3'
  | 'dynamodb' | 'mapbox' | 'termii' | 'hubtel' | 'other';

export interface ExternalServiceIssue {
  service: ExternalService;
  capability?: CapabilityId;
  httpStatus?: number;        // e.g. 503
  message: string;
  /** true for provider-side faults (5xx / timeout / quota) — not our code. */
  transient: boolean;
}

export interface ClassifiedFailure {
  origin: FailureOrigin;
  area: 'structural' | 'runtime' | 'functional' | 'performance' | 'security';
  detail: string;
  external?: ExternalServiceIssue;
  /** internal → Repairer acts; external → reported only, code left untouched. */
  repairable: boolean;
  /**
   * Set when this failure came from the Integration Registry
   * (services/engine/integration-registry.ts) — lets repairer.ts dispatch
   * generically to the owning IntegrationRule's apply() instead of
   * regex-matching `detail` against a hand-coded list of known shapes.
   */
  integrationId?: string;
}

// ── 2. Performance verification ──────────────────────────────────────────────
export type PerfMetricName =
  | 'page_render' | 'time_to_interactive' | 'dashboard_load'
  | 'login_response' | 'search_response' | 'api_latency';

export interface PerfMeasurement {
  metric: PerfMetricName;
  target: string;            // route/endpoint measured
  valueMs: number;
  thresholdMs: number;       // configurable budget (resolved from config)
  withinBudget: boolean;
}

/** Configurable per-metric budgets (ms). Resolved from config at runtime. */
export type PerformanceThresholds = Partial<Record<PerfMetricName, number>>;

// ── 3. Security verification ─────────────────────────────────────────────────
export type SecurityCheckKind =
  | 'protected_route_requires_auth' | 'cross_user_data_isolation'
  | 'authorization_enforced' | 'api_rejects_unauthorized'
  | 'input_validation' | 'session_token_verification';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecurityCheck {
  kind: SecurityCheckKind;
  label: string;
  severity: SecuritySeverity;
  target: string;            // route/endpoint checked
  status: 'passed' | 'failed' | 'skipped' | 'not_applicable';
  detail?: string;
}

// ── VerifyResult: objective proof the build is usable ────────────────────────
export interface VerifyResult {
  // structural
  fileCount: number;
  routes: string[];
  apiRoutes: string[];
  pagesGenerated: number;
  deadLinks: string[];       // referenced routes with no page → 404 risk
  notFoundRoutes: string[];  // routes that returned 404 at runtime (if server checked)
  brokenImports: string[];
  buildErrors: string[];
  // runtime
  previewUrl: string | null;
  previewLoads: boolean | null; // null = not checked (no running server)
  // functional
  workflowTests: WorkflowTest[];
  workflowsPassed: boolean;     // all APPLICABLE workflows passed
  // external-dependency awareness
  externalIssues: ExternalServiceIssue[];   // reported, never repaired
  classifiedFailures: ClassifiedFailure[];  // internal vs external, for the Repairer
  // performance
  performance: PerfMeasurement[];
  performanceWithinBudget: boolean;
  // security
  securityChecks: SecurityCheck[];
  securityPassed: boolean;      // all CRITICAL security checks passed
  /**
   * Real headless-browser click-through journey (register/login/nav/logout),
   * as opposed to workflowTests above which are plain HTTP probes. null when
   * no browserJourney dep was supplied or no live preview existed to test
   * against — NOT the same as a passing result, callers must check for null
   * explicitly rather than treating it as vacuously true.
   */
  browserJourney: { passed: boolean; verdict: string; summary: string; failureDetail?: string } | null;
  /**
   * The hard Success Rule. passed === true requires ALL of:
   *  structural OK ∧ previewLoads ∧ workflowsPassed ∧ performanceWithinBudget ∧
   *  securityPassed ∧ no INTERNAL classifiedFailures.
   * External (third-party) failures do NOT block success on their own and do NOT
   * trigger repair — they are surfaced via externalIssues for the user/ops.
   */
  passed: boolean;
}

// ── RepairResult: outcome of a bounded repair loop ───────────────────────────
export interface RepairResult {
  attempts: number;
  maxAttempts: number;
  changedFiles: string[];
  resolved: boolean;
  remainingIssues: string[];
  /** External-service failures the Repairer deliberately did NOT touch (reported up). */
  skippedExternalIssues: ExternalServiceIssue[];
  /** Why the repair loop stopped (skipped / resolved / no-change / stalled / max attempts). */
  stopReason?: string;
  /** Per-iteration audit: attempt number, failures targeted, files changed. */
  iterations?: { attempt: number; targeted: string[]; changedFiles: string[] }[];
}

// ── EngineReport: the single artifact returned to the caller/UI ──────────────
export type EngineStatus = 'planning' | 'building' | 'verifying' | 'repairing' | 'complete' | 'failed';

export interface EngineReport {
  status: EngineStatus;
  intent: DetectedIntent | null;
  plan: AppPlan | null;
  build: BuildResult | null;
  verify: VerifyResult | null;
  repair: RepairResult | null;
  /** True ONLY when the Success Rule passed on fresh files. Kept for backward
   *  compatibility / the single "all-clear" banner — but DO NOT use this to gate
   *  the preview link or any individual stage's status. Use the four fields below
   *  instead: each stage is independent and none should block the others. */
  success: boolean;
  /** Human-readable summary for the build report UI. */
  summary: string;
  /** Public preview URL once a dev server is started for the generated project. */
  previewUrl?: string | null;
  /** Why the preview could not start, if applicable (shown instead of spinning). */
  previewError?: string;
  startedAt: string;
  finishedAt: string | null;

  // ── Independent per-stage status (added so the UI can show Build/Preview/
  //    Verify/Repair as four separate signals instead of one combined blocked
  //    state). A failure or timeout in Verify/Repair must NEVER hide the preview
  //    link when Build succeeded and Preview actually started — humans testing
  //    the generated app on localhost need that link regardless of verify/repair
  //    outcome. Preview is hidden ONLY when no files were generated, or the
  //    preview server itself failed to start. ─────────────────────────────────
  /** 'success' iff the Builder wrote real files to a fresh folder. */
  buildStatus: 'success' | 'failed';
  /** 'available' iff previewUrl is set — i.e. a dev server actually started.
   *  Never derived from verify/repair outcome. */
  previewStatus: 'available' | 'unavailable';
  /** 'not_run' when Verify never completed (e.g. it errored/timed out) — distinct
   *  from 'failed' (it ran and found real issues). */
  verifyStatus: 'passed' | 'failed' | 'not_run';
  /** 'not_run' when Repair was never triggered (verify passed, or nothing
   *  repairable). 'timed_out' is distinct from 'failed' so the UI/user knows the
   *  repair loop was cut off rather than having exhausted its attempts normally. */
  repairStatus: 'passed' | 'failed' | 'timed_out' | 'not_run';
}
