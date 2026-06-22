/**
 * Root Cause Investigation Engine
 *
 * Runs BEFORE any code modification. Investigates the actual cause of failure
 * across all system layers: frontend, backend, API, database, auth,
 * credentials, configuration, infrastructure, and permissions.
 *
 * Produces a structured RootCauseReport that drives targeted, layer-specific fixes.
 * The platform must never modify files before this report is produced.
 */

import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import { getServerLogs } from './project-runner';

// ── Types ─────────────────────────────────────────────────────────────────────

export type IssueLayer =
  | 'frontend'       // UI rendering, component errors, CSS/layout, hydration
  | 'backend'        // API routes, server logic, data processing
  | 'api'            // External API calls, provider issues, rate limits
  | 'database'       // DB connections, queries, schema, migrations
  | 'auth'           // Authentication, sessions, JWT, Cognito, next-auth
  | 'credentials'    // Missing/invalid/placeholder env vars or API keys
  | 'configuration'  // next.config, tsconfig, package.json, tailwind config
  | 'infrastructure' // Port conflicts, process crashes, memory, Docker
  | 'permissions'    // File system, IAM, CORS, CSP
  | 'deployment'     // Build failures, deploy errors, CI/CD
  | 'unknown';

export interface RootCauseFinding {
  layer: IssueLayer;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  evidence?: string;
  fixHint?: string;
  autoFixable: boolean;
}

export interface EndpointProbeResult {
  url: string;
  name: string;
  statusCode?: number;
  ok: boolean;
  latencyMs?: number;
  errorBody?: string;
  error?: string;
}

export interface RootCauseReport {
  /** The primary layer where the issue originates */
  primaryLayer: IssueLayer;
  confidence: 'high' | 'medium' | 'low';
  /** Plain-English one-paragraph summary shown to the user */
  summary: string;
  /** All findings, ordered by severity (critical first) */
  findings: RootCauseFinding[];
  /** Env var names that are missing or contain placeholder values */
  missingCredentials: string[];
  placeholderEnvVars: string[];
  /** HTTP probe results for each live endpoint */
  endpointProbes: EndpointProbeResult[];
  databaseStatus?: { connected: boolean; error?: string };
  authStatus?: { configured: boolean; issue?: string };
  /** Recent server log lines that contain error signals */
  logExcerpts: string[];
  canAutoFix: boolean;
  recommendedActions: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_VALUES = new Set([
  'placeholder-replace-before-deploying',
  'your_key_here',
  'xxx',
  'replace_me',
  'change_before_deploying',
  'your-secret-here',
  'PASTE_MY_X_RAPIDAPI_KEY_HERE',
  'sk_test_placeholder',
  'pk_test_placeholder',
  '',
]);

const CREDENTIALS_VARS = [
  'RAPIDAPI_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY',
  'PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'RESEND_API_KEY', 'SENDGRID_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_MAPS_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'DATABASE_URL',
  'NEXTAUTH_SECRET', 'AUTH_SECRET', 'JWT_SECRET', 'SESSION_SECRET',
];

const AUTH_PATTERNS = [
  /NEXTAUTH_SECRET/i, /AUTH_SECRET/i, /\[next-auth\]/i, /next-auth.*error/i,
  /invalid.*jwt/i, /jwt.*expired/i, /session.*expired/i, /unauthorized/i,
  /auth.*not.*configured/i,
];

const DB_ERROR_PATTERNS = [
  /SQLITE_ERROR/i, /SQLITE_CANTOPEN/i, /database.*locked/i,
  /no such table/i, /no such column/i,
  /PrismaClientKnownRequestError/i, /PrismaClientInitializationError/i,
  /relation.*does not exist/i, /connection.*refused/i,
  /ECONNREFUSED.*5432/i, /ECONNREFUSED.*3306/i, /MongoDB.*connection/i,
];

const CREDENTIAL_ERROR_PATTERNS = [
  /api.?key.*invalid/i, /invalid.*api.?key/i, /unauthorized.*api/i,
  /missing.*api.?key/i, /api.*not.*configured/i,
  /RAPIDAPI.*key/i, /X-RapidAPI-Key/i,
];

// ── Env file inspection ───────────────────────────────────────────────────────

async function readEnvFile(projectPath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ['.env.local', '.env', '.env.development']) {
    try {
      const raw = await readFile(join(projectPath, name), 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) result[key] = val;
      }
      break; // use first file found
    } catch { /* continue */ }
  }
  return result;
}

function findMissingCredentials(envVars: Record<string, string>): {
  missing: string[];
  placeholder: string[];
} {
  const missing: string[] = [];
  const placeholder: string[] = [];

  for (const key of CREDENTIALS_VARS) {
    const val = envVars[key];
    if (val === undefined) {
      missing.push(key);
    } else if (PLACEHOLDER_VALUES.has(val) || val.length < 5) {
      placeholder.push(key);
    }
  }
  return { missing, placeholder };
}

// ── Log analysis ──────────────────────────────────────────────────────────────

async function analyzeServerLogs(projectPath: string): Promise<{
  errorLines: string[];
  layer: IssueLayer | null;
}> {
  try {
    const raw = await getServerLogs(projectPath);
    const lines = raw.split('\n');
    const errorLines = lines
      .filter(l => /error|failed|crash|exception|cannot find|module not found|enoent|econnrefused|unauthorized|forbidden|invalid|missing/i.test(l))
      .slice(-20)
      .map(l => l.trim())
      .filter(Boolean);

    let layer: IssueLayer | null = null;
    const joined = errorLines.join('\n').toLowerCase();

    if (DB_ERROR_PATTERNS.some(re => re.test(joined))) layer = 'database';
    else if (AUTH_PATTERNS.some(re => re.test(joined))) layer = 'auth';
    else if (CREDENTIAL_ERROR_PATTERNS.some(re => re.test(joined))) layer = 'credentials';
    else if (/module not found|cannot find module/i.test(joined)) layer = 'configuration';
    else if (/econnrefused|enoent|eaddrinuse/i.test(joined)) layer = 'infrastructure';
    else if (/error ts\d+|typescript/i.test(joined)) layer = 'backend';
    else if (/hydration|chunkloaderror|minified react/i.test(joined)) layer = 'frontend';

    return { errorLines, layer };
  } catch {
    return { errorLines: [], layer: null };
  }
}

// ── Database probe ────────────────────────────────────────────────────────────

async function probeDatabaseHealth(projectPath: string, envVars: Record<string, string>): Promise<{
  connected: boolean;
  error?: string;
}> {
  // Check for SQLite file existence
  const dbPaths = ['data/database.db', 'database.db', 'data/db.sqlite', 'db.sqlite', 'prisma/dev.db'];
  for (const p of dbPaths) {
    try {
      await access(join(projectPath, p));
      return { connected: true };
    } catch { /* continue */ }
  }

  // Check if DATABASE_URL is configured
  const dbUrl = envVars['DATABASE_URL'];
  if (!dbUrl) {
    // Check if there's any DB-related code
    try {
      const files = await readdir(join(projectPath, 'lib')).catch(() => [] as string[]);
      const hasDb = files.some(f => /db|database|prisma|supabase/i.test(f));
      if (hasDb) {
        return { connected: false, error: 'DATABASE_URL is not configured' };
      }
    } catch { /* no lib dir */ }
  }

  return { connected: true }; // No DB usage detected — not a DB issue
}

// ── Auth probe ────────────────────────────────────────────────────────────────

async function probeAuthConfiguration(projectPath: string, envVars: Record<string, string>): Promise<{
  configured: boolean;
  issue?: string;
}> {
  // Check for next-auth
  const hasNextAuth = envVars['NEXTAUTH_SECRET'] || envVars['AUTH_SECRET'];
  const hasAuthRoute = await access(join(projectPath, 'app/api/auth/[...nextauth]/route.ts'))
    .then(() => true).catch(() => false);
  const hasNextAuthPkg = await readFile(join(projectPath, 'package.json'), 'utf-8')
    .then(raw => /"next-auth"|"@auth\/core"|"next-auth@"/.test(raw))
    .catch(() => false);

  if (hasNextAuthPkg && !hasNextAuth) {
    return { configured: false, issue: 'next-auth is installed but NEXTAUTH_SECRET is missing — add it to .env.local' };
  }
  if (hasNextAuthPkg && !hasAuthRoute) {
    return { configured: false, issue: 'next-auth route (app/api/auth/[...nextauth]/route.ts) is missing' };
  }

  return { configured: true };
}

// ── HTTP endpoint probing ─────────────────────────────────────────────────────

async function probeEndpoint(url: string, name: string): Promise<EndpointProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json, text/html' },
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const bodyText = await res.text().catch(() => '');
    const errorBody = !res.ok ? bodyText.slice(0, 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined;

    return { url, name, statusCode: res.status, ok: res.ok, latencyMs, errorBody };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      url, name, ok: false,
      error: isAbort ? 'Timed out after 8s — server may be hanging or not running' : 'Connection refused — server not running',
    };
  }
}

async function probeAllEndpoints(port: number, projectPath: string): Promise<EndpointProbeResult[]> {
  const base = `http://localhost:${port}`;
  const probes: EndpointProbeResult[] = [];

  // Always probe main page
  probes.push(await probeEndpoint(`${base}/`, 'Main page'));

  // Discover API routes from file system
  const apiDir = join(projectPath, 'app', 'api');
  try {
    const apiEntries = await readdir(apiDir, { withFileTypes: true });
    for (const entry of apiEntries.slice(0, 8)) {
      if (!entry.isDirectory() || entry.name.startsWith('[') || entry.name.startsWith('.')) continue;
      const urlPath = `/api/${entry.name}`;
      probes.push(await probeEndpoint(`${base}${urlPath}`, `API: ${urlPath}`));
    }
  } catch { /* no api dir */ }

  return probes;
}

// ── Issue classification ──────────────────────────────────────────────────────

function classifyByProbes(
  probes: EndpointProbeResult[],
  envVars: Record<string, string>,
  logLayer: IssueLayer | null,
): IssueLayer {
  const failedProbes = probes.filter(p => !p.ok);
  if (failedProbes.length === 0) return logLayer ?? 'unknown';

  // All endpoints down → infrastructure/server issue
  if (failedProbes.length === probes.length) return 'infrastructure';

  // Main page passes but API routes fail → backend
  const mainPassed = probes.find(p => p.url.endsWith('/'))?.ok ?? false;
  const apisFailed = probes.filter(p => p.url.includes('/api/') && !p.ok);
  if (mainPassed && apisFailed.length > 0) {
    // Check error body for clues
    const errorBodies = apisFailed.map(p => p.errorBody ?? '').join('\n');
    if (CREDENTIAL_ERROR_PATTERNS.some(re => re.test(errorBodies))) return 'credentials';
    if (DB_ERROR_PATTERNS.some(re => re.test(errorBodies))) return 'database';
    if (AUTH_PATTERNS.some(re => re.test(errorBodies))) return 'auth';
    return 'backend';
  }

  // Main page fails, APIs may work → frontend
  if (!mainPassed) return 'frontend';

  return logLayer ?? 'backend';
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(params: {
  layer: IssueLayer;
  findings: RootCauseFinding[];
  missing: string[];
  placeholder: string[];
  probes: EndpointProbeResult[];
  dbStatus?: { connected: boolean; error?: string };
  authStatus?: { configured: boolean; issue?: string };
  logExcerpts: string[];
  logLayer: IssueLayer | null;
}): RootCauseReport {
  const { layer, findings, missing, placeholder, probes, dbStatus, authStatus, logExcerpts } = params;

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const canAutoFix = criticalCount > 0 && findings.filter(f => f.severity === 'critical' && !f.autoFixable).length === 0;

  const recommendedActions = findings
    .filter(f => f.severity === 'critical' && f.fixHint)
    .map(f => f.fixHint!)
    .slice(0, 5);

  if (recommendedActions.length === 0) {
    if (layer === 'credentials') recommendedActions.push('Add missing API keys or credentials to .env.local');
    else if (layer === 'database') recommendedActions.push('Initialize the database with initTable() before queries');
    else if (layer === 'auth') recommendedActions.push('Add NEXTAUTH_SECRET to .env.local and restart the server');
    else if (layer === 'backend') recommendedActions.push('Check API route files for server-side errors');
    else if (layer === 'frontend') recommendedActions.push('Check for missing "use client" directives or hydration errors');
    else recommendedActions.push('Investigate server logs for the specific error');
  }

  // Generate summary
  const failedEndpoints = probes.filter(p => !p.ok);
  let summary = `The issue is in the **${layer}** layer. `;

  if (layer === 'credentials') {
    summary += `${missing.length + placeholder.length} required credential(s) are missing or contain placeholder values. `;
    summary += `No external API will work until these are set. This is NOT a code problem — add the real keys to .env.local.`;
  } else if (layer === 'database') {
    summary += `The database is unreachable or not initialized. `;
    summary += dbStatus?.error ?? 'Ensure the database is set up and migrations have run.';
  } else if (layer === 'auth') {
    summary += authStatus?.issue ?? 'Authentication configuration is incomplete.';
  } else if (layer === 'infrastructure') {
    summary += `The server process is not running or the port is unavailable. `;
    summary += failedEndpoints.length > 0 ? `${failedEndpoints.length} endpoint(s) are unreachable.` : '';
  } else if (layer === 'backend') {
    summary += `${failedEndpoints.filter(p => p.url.includes('/api/')).length} API route(s) are returning errors. `;
    summary += `The frontend may be fine — the server-side logic needs repair.`;
  } else if (layer === 'frontend') {
    summary += `The frontend is failing to render. Backend APIs may be working correctly.`;
  } else {
    summary += criticalCount > 0
      ? `${criticalCount} critical issue(s) were found.`
      : 'No specific issues identified — check server logs for details.';
  }

  // Confidence
  let confidence: RootCauseReport['confidence'] = 'medium';
  if ((missing.length > 0 || placeholder.length > 0) && layer === 'credentials') confidence = 'high';
  else if (failedEndpoints.length === 0 && logExcerpts.length === 0) confidence = 'low';
  else if (criticalCount >= 2) confidence = 'high';

  return {
    primaryLayer: layer,
    confidence,
    summary,
    findings: findings.sort((a, b) =>
      (a.severity === 'critical' ? 0 : a.severity === 'warning' ? 1 : 2) -
      (b.severity === 'critical' ? 0 : b.severity === 'warning' ? 1 : 2)
    ),
    missingCredentials: missing,
    placeholderEnvVars: placeholder,
    endpointProbes: probes,
    databaseStatus: dbStatus,
    authStatus,
    logExcerpts,
    canAutoFix,
    recommendedActions,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InvestigateOptions {
  projectPath: string;
  port?: number;
  /** Pass existing server logs if already captured */
  rawLogs?: string;
}

/**
 * Investigate a project's current state and return a structured root cause report.
 * This must be called BEFORE any file modifications.
 */
export async function investigateRootCause(opts: InvestigateOptions): Promise<RootCauseReport> {
  const { projectPath, port } = opts;
  const findings: RootCauseFinding[] = [];

  // ── 1. Read env vars ───────────────────────────────────────────────────────
  const envVars = await readEnvFile(projectPath);
  const { missing, placeholder } = findMissingCredentials(envVars);

  if (missing.length > 0) {
    findings.push({
      layer: 'credentials',
      severity: 'critical',
      title: 'Missing credentials',
      detail: `These required env vars are not set: ${missing.join(', ')}`,
      fixHint: `Add the following to .env.local: ${missing.map(k => `${k}=<your-key>`).join(', ')}`,
      autoFixable: false,
    });
  }

  if (placeholder.length > 0) {
    findings.push({
      layer: 'credentials',
      severity: 'critical',
      title: 'Placeholder credentials detected',
      detail: `These env vars contain placeholder values and must be replaced with real keys: ${placeholder.join(', ')}`,
      fixHint: `Replace placeholder values in .env.local for: ${placeholder.join(', ')}`,
      autoFixable: false,
    });
  }

  // ── 2. Analyze server logs ─────────────────────────────────────────────────
  const { errorLines: logExcerpts, layer: logLayer } = await analyzeServerLogs(projectPath);

  if (logExcerpts.length > 0 && logLayer) {
    findings.push({
      layer: logLayer,
      severity: 'warning',
      title: 'Server log errors detected',
      detail: logExcerpts.slice(0, 3).join(' | '),
      evidence: logExcerpts.join('\n'),
      autoFixable: false,
    });
  }

  // ── 3. Probe live endpoints ────────────────────────────────────────────────
  const probes: EndpointProbeResult[] = port
    ? await probeAllEndpoints(port, projectPath)
    : [];

  for (const probe of probes.filter(p => !p.ok)) {
    const errorText = probe.errorBody ?? probe.error ?? '';
    let layer: IssueLayer = 'backend';
    let title = `${probe.name} is failing (HTTP ${probe.statusCode ?? 'connection refused'})`;

    if (DB_ERROR_PATTERNS.some(re => re.test(errorText))) {
      layer = 'database';
      title = `Database error in ${probe.name}`;
    } else if (AUTH_PATTERNS.some(re => re.test(errorText))) {
      layer = 'auth';
      title = `Auth error in ${probe.name}`;
    } else if (CREDENTIAL_ERROR_PATTERNS.some(re => re.test(errorText))) {
      layer = 'credentials';
      title = `Invalid/missing API key in ${probe.name}`;
    } else if (!probe.url.includes('/api/')) {
      layer = 'frontend';
    } else if (!probe.statusCode) {
      layer = 'infrastructure';
      title = `${probe.name} is unreachable`;
    }

    findings.push({
      layer,
      severity: 'critical',
      title,
      detail: errorText.slice(0, 200) || probe.error || `HTTP ${probe.statusCode}`,
      fixHint: probe.url.includes('/api/')
        ? `Check app/api/${probe.url.split('/api/')[1]?.split('/')[0]}/route.ts for errors`
        : 'Check app/page.tsx and the main layout for rendering errors',
      autoFixable: layer === 'auth' || layer === 'missing-env' as IssueLayer,
    });
  }

  // ── 4. Database probe ──────────────────────────────────────────────────────
  const dbStatus = await probeDatabaseHealth(projectPath, envVars);
  if (!dbStatus.connected) {
    findings.push({
      layer: 'database',
      severity: 'critical',
      title: 'Database connection failed',
      detail: dbStatus.error ?? 'Cannot connect to the database',
      fixHint: 'Ensure DATABASE_URL is set and the database server is running. For SQLite, ensure the db file exists.',
      autoFixable: false,
    });
  }

  // ── 5. Auth probe ──────────────────────────────────────────────────────────
  const authStatus = await probeAuthConfiguration(projectPath, envVars);
  if (!authStatus.configured) {
    findings.push({
      layer: 'auth',
      severity: 'critical',
      title: 'Authentication not configured',
      detail: authStatus.issue ?? 'Auth configuration is incomplete',
      fixHint: 'Add NEXTAUTH_SECRET to .env.local and ensure the auth route exists',
      autoFixable: true,
    });
  }

  // ── 6. Classify primary layer ──────────────────────────────────────────────
  let primaryLayer: IssueLayer = 'unknown';

  if (findings.length > 0) {
    // Credentials always take priority — most common root cause
    if (findings.some(f => f.layer === 'credentials' && f.severity === 'critical')) {
      primaryLayer = 'credentials';
    } else if (findings.some(f => f.layer === 'database' && f.severity === 'critical')) {
      primaryLayer = 'database';
    } else if (findings.some(f => f.layer === 'auth' && f.severity === 'critical')) {
      primaryLayer = 'auth';
    } else if (findings.some(f => f.layer === 'infrastructure' && f.severity === 'critical')) {
      primaryLayer = 'infrastructure';
    } else {
      // Use endpoint analysis to distinguish frontend vs backend
      primaryLayer = classifyByProbes(probes, envVars, logLayer);
    }
  } else if (probes.length > 0) {
    primaryLayer = classifyByProbes(probes, envVars, logLayer);
  } else {
    primaryLayer = logLayer ?? 'unknown';
  }

  return buildReport({
    layer: primaryLayer,
    findings,
    missing,
    placeholder,
    probes,
    dbStatus: dbStatus.connected ? undefined : dbStatus,
    authStatus: authStatus.configured ? undefined : authStatus,
    logExcerpts,
    logLayer,
  });
}

/**
 * Format a RootCauseReport into a human-readable string for display in the builder.
 */
export function formatRootCauseReport(report: RootCauseReport): string {
  const lines: string[] = [];
  const LAYER_LABELS: Record<IssueLayer, string> = {
    frontend: '🖥️ Frontend (UI / Rendering)',
    backend: '⚙️ Backend (API Routes / Server Logic)',
    api: '🌐 External API',
    database: '🗄️ Database',
    auth: '🔐 Authentication',
    credentials: '🔑 Credentials / API Keys',
    configuration: '⚙️ Configuration',
    infrastructure: '🏗️ Infrastructure (Server Process)',
    permissions: '🔒 Permissions',
    deployment: '🚀 Deployment',
    unknown: '❓ Unknown',
  };

  lines.push(`**Root Cause: ${LAYER_LABELS[report.primaryLayer]}**`);
  lines.push(`*Confidence: ${report.confidence}*`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  if (report.findings.length > 0) {
    lines.push('**Findings:**');
    for (const f of report.findings.filter(f => f.severity === 'critical').slice(0, 5)) {
      lines.push(`• ❌ ${f.title}: ${f.detail}`);
    }
    const warnings = report.findings.filter(f => f.severity === 'warning').slice(0, 3);
    if (warnings.length > 0) {
      for (const f of warnings) {
        lines.push(`• ⚠️ ${f.title}`);
      }
    }
    lines.push('');
  }

  if (report.endpointProbes.length > 0) {
    lines.push('**Endpoint Status:**');
    for (const p of report.endpointProbes.slice(0, 6)) {
      lines.push(`• ${p.ok ? '✅' : '❌'} ${p.name}${p.statusCode ? ` (HTTP ${p.statusCode})` : ''}${p.latencyMs ? ` — ${p.latencyMs}ms` : ''}`);
    }
    lines.push('');
  }

  if (report.recommendedActions.length > 0) {
    lines.push('**Recommended Actions:**');
    report.recommendedActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }

  return lines.join('\n');
}
