/**
 * Flow Tracer
 *
 * When a route fails, trace the full stack: UI → Route → API → Auth → Database.
 * Reads source files to identify exactly which layer is broken.
 *
 * Example: GET /api/listings returns 401
 *   UI layer:     app/listings/page.tsx calls fetch('/api/listings')  ✅ correct
 *   Route layer:  app/api/listings/route.ts exports GET               ✅ present
 *   Auth layer:   getAuthUser() is called without await              ❌ BROKEN
 *   Database:     (unreachable — auth fails first)                   ⚠ unknown
 *   Diagnosis: Missing await on getAuthUser() — returns a Promise instead of user object
 *   Fix: Add await to getAuthUser() call in app/api/listings/route.ts
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LayerStatus = 'ok' | 'broken' | 'warning' | 'unknown';

export interface FlowLayer {
  layer: 'ui' | 'route' | 'auth' | 'database' | 'external';
  label: string;
  file?: string;
  status: LayerStatus;
  evidence: string;
}

export interface FlowTrace {
  /** The failing URL path (e.g., /api/listings) */
  failingPath: string;
  /** HTTP status that was returned */
  httpStatus: number;
  /** Which layer is the root cause */
  brokenLayer?: FlowLayer;
  /** All layers analyzed */
  layers: FlowLayer[];
  /** One-line diagnosis */
  diagnosis: string;
  /** Specific file to edit */
  fixFile?: string;
  /** What the fix should do */
  fixHint: string;
}

// ─── Source readers ───────────────────────────────────────────────────────────

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function findPagesReferencing(apiPath: string, projectPath: string): Promise<string[]> {
  const matches: string[] = [];
  const appDir = join(projectPath, 'app');

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.next', '.git', 'api'].includes(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.name.endsWith('.tsx') && !e.name.endsWith('.ts')) continue;
      try {
        const src = await readFile(abs, 'utf-8');
        if (src.includes(apiPath) || src.includes(`'${apiPath}'`) || src.includes(`"${apiPath}"`)) {
          matches.push(abs.replace(projectPath + '/', ''));
        }
      } catch { /* skip */ }
    }
  }

  await walk(appDir);
  return matches;
}

// ─── Layer analyzers ──────────────────────────────────────────────────────────

function analyzeUiLayer(referencingPages: string[], apiPath: string): FlowLayer {
  if (referencingPages.length === 0) {
    return {
      layer: 'ui',
      label: 'UI Layer',
      status: 'warning',
      evidence: `No page.tsx found that calls ${apiPath} — this route may be called directly or the path is dynamic`,
    };
  }
  return {
    layer: 'ui',
    label: 'UI Layer',
    file: referencingPages[0],
    status: 'ok',
    evidence: `${referencingPages.length} page(s) reference this path: ${referencingPages.join(', ')}`,
  };
}

function analyzeRouteLayer(routeSrc: string | null, routeFile: string, method: string): FlowLayer {
  if (!routeSrc) {
    return {
      layer: 'route',
      label: 'Route Handler',
      file: routeFile,
      status: 'broken',
      evidence: `Route file ${routeFile} does not exist`,
    };
  }

  const hasMethod = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(routeSrc);
  if (!hasMethod) {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].filter(m =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(routeSrc)
    );
    return {
      layer: 'route',
      label: 'Route Handler',
      file: routeFile,
      status: 'broken',
      evidence: `Route file exists but does NOT export ${method}. Present: ${methods.join(', ') || 'none'}`,
    };
  }

  return {
    layer: 'route',
    label: 'Route Handler',
    file: routeFile,
    status: 'ok',
    evidence: `Exports ${method} handler`,
  };
}

function analyzeAuthLayer(routeSrc: string, httpStatus: number): FlowLayer {
  const hasAuthCall = /getAuthUser|getAuthenticatedUser|verifyToken|requireAuth/.test(routeSrc);

  if (!hasAuthCall) {
    if (httpStatus === 401) {
      return {
        layer: 'auth',
        label: 'Auth Guard',
        status: 'broken',
        evidence: 'Route returned 401 but no auth call found in source — middleware or a called function may be rejecting the request',
      };
    }
    return {
      layer: 'auth',
      label: 'Auth Guard',
      status: 'ok',
      evidence: 'No auth guard in this route (public route)',
    };
  }

  // Check for missing await on async auth calls
  const missingAwait = /(?<!\bawait\s+)\bgetAuthUser\s*\(|(?<!\bawait\s+)\bverifyToken\s*\(/.test(routeSrc);
  if (missingAwait) {
    return {
      layer: 'auth',
      label: 'Auth Guard',
      status: 'broken',
      evidence: 'getAuthUser() called WITHOUT await — returns a Promise<AuthUser> instead of AuthUser, so all property access fails',
    };
  }

  // Check if auth result is checked
  const authVarMatch = routeSrc.match(/const\s+(\w+)\s*=\s*await\s+getAuthUser/);
  if (authVarMatch) {
    const varName = authVarMatch[1];
    const isChecked = new RegExp(`if\\s*\\(!?\\s*${varName}\\b`).test(routeSrc) ||
                      new RegExp(`${varName}\\s*===\\s*null`).test(routeSrc);
    if (!isChecked && httpStatus === 401) {
      return {
        layer: 'auth',
        label: 'Auth Guard',
        status: 'broken',
        evidence: `getAuthUser() result (${varName}) is not checked for null — unauthenticated requests proceed and crash later`,
      };
    }
  }

  return {
    layer: 'auth',
    label: 'Auth Guard',
    status: httpStatus === 401 ? 'warning' : 'ok',
    evidence: httpStatus === 401
      ? 'Auth guard present and correctly implemented — 401 is expected for unauthenticated test requests'
      : 'Auth guard present and awaited correctly',
  };
}

function analyzeDatabaseLayer(routeSrc: string, httpStatus: number): FlowLayer {
  const hasDbCall = /\bdb\.\w+\s*\(|initTable\s*\(|\.query\s*\(|\.execute\s*\(/.test(routeSrc);

  if (!hasDbCall) {
    return {
      layer: 'database',
      label: 'Database',
      status: 'ok',
      evidence: 'No direct database calls in this route',
    };
  }

  // Check for common DB mistakes
  const hasInitTable = /initTable\s*\(/.test(routeSrc);
  const hasDbAllMistake = /db\.all\s*\(/.test(routeSrc) && !/\bdb\b.*\ball\b/.test(routeSrc);

  if (httpStatus >= 500) {
    // Look for specific error patterns in source
    const missingInit = !hasInitTable && /SELECT|INSERT|UPDATE|DELETE/.test(routeSrc);
    if (missingInit) {
      return {
        layer: 'database',
        label: 'Database',
        status: 'broken',
        evidence: 'Route queries database but initTable() is not called — table may not exist yet',
      };
    }
    return {
      layer: 'database',
      label: 'Database',
      status: 'warning',
      evidence: `Route has DB calls and returned HTTP ${httpStatus} — check initTable() and schema column names`,
    };
  }

  return {
    layer: 'database',
    label: 'Database',
    file: undefined,
    status: 'ok',
    evidence: `DB calls present${hasInitTable ? ', initTable() found' : ''}`,
  };
}

function analyzeExternalLayer(routeSrc: string, httpStatus: number): FlowLayer | null {
  const hasExternalCall = /fetch\s*\(\s*['"`]https?:\/\/|axios\.|request\(|openai\.|anthropic\./.test(routeSrc);
  if (!hasExternalCall) return null;

  const hasTimeout = /AbortSignal\.timeout|setTimeout.*abort|signal.*timeout/i.test(routeSrc);
  const hasErrorHandling = /try\s*\{[\s\S]*?fetch[\s\S]*?\}\s*catch/.test(routeSrc);

  if (!hasTimeout && !hasErrorHandling && httpStatus >= 500) {
    return {
      layer: 'external',
      label: 'External API',
      status: 'broken',
      evidence: 'Route calls an external API without timeout or error handling — will crash or hang if the API is unavailable',
    };
  }

  return {
    layer: 'external',
    label: 'External API',
    status: 'ok',
    evidence: `External API call found${hasTimeout ? ' with timeout' : ' (no timeout — consider adding one)'}`,
  };
}

// ─── Diagnosis builder ────────────────────────────────────────────────────────

function buildDiagnosis(layers: FlowLayer[], httpStatus: number, path: string): {
  brokenLayer?: FlowLayer;
  diagnosis: string;
  fixFile?: string;
  fixHint: string;
} {
  const broken = layers.find(l => l.status === 'broken');

  if (!broken) {
    // No broken layer found — check if 401 is expected (auth protected route tested without credentials)
    const authLayer = layers.find(l => l.layer === 'auth');
    if (httpStatus === 401 && authLayer?.evidence.includes('expected')) {
      return {
        diagnosis: `Route is auth-protected and correctly returns 401 for unauthenticated requests`,
        fixFile: undefined,
        fixHint: 'This is not a bug — the route correctly requires authentication. Test with a valid session cookie.',
      };
    }
    return {
      diagnosis: `HTTP ${httpStatus} from ${path} — no structural issue found in source; check runtime logs`,
      fixHint: 'Check server logs for the actual error. The source looks correct but the runtime error is not visible from static analysis.',
    };
  }

  // Build fix hint from broken layer
  let fixHint = broken.evidence;
  let fixFile = broken.file;

  if (broken.layer === 'route' && !broken.file?.includes('route.ts')) {
    fixHint = `Create ${broken.file ?? `app/api${path}/route.ts`} with a ${httpStatus === 405 ? 'GET/POST' : 'GET'} handler`;
    fixFile = broken.file ?? `app/api${path}/route.ts`;
  } else if (broken.layer === 'auth' && broken.evidence.includes('await')) {
    const routeLayer = layers.find(l => l.layer === 'route');
    fixFile = routeLayer?.file;
    fixHint = `Add "await" before getAuthUser(request) in ${fixFile ?? 'the route file'}`;
  } else if (broken.layer === 'database') {
    const routeLayer = layers.find(l => l.layer === 'route');
    fixFile = routeLayer?.file;
  }

  return {
    brokenLayer: broken,
    diagnosis: `${broken.label} is broken: ${broken.evidence.slice(0, 120)}`,
    fixFile,
    fixHint,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function traceFailure(
  path: string,
  httpStatus: number,
  method: string = 'GET',
  projectPath: string,
): Promise<FlowTrace> {
  // Derive route file from path
  const routeFile = `app/api${path}/route.ts`.replace(/\/+/g, '/');
  const absRouteFile = join(projectPath, routeFile);

  const [routeSrc, referencingPages] = await Promise.all([
    safeRead(absRouteFile),
    findPagesReferencing(path, projectPath),
  ]);

  const layers: FlowLayer[] = [];

  // UI layer — which pages call this route?
  layers.push(analyzeUiLayer(referencingPages, path));

  // Route layer — does the handler exist?
  layers.push(analyzeRouteLayer(routeSrc, routeFile, method));

  // Auth layer — is auth correctly awaited?
  if (routeSrc) {
    layers.push(analyzeAuthLayer(routeSrc, httpStatus));
  }

  // Database layer — is DB correctly initialized?
  if (routeSrc) {
    layers.push(analyzeDatabaseLayer(routeSrc, httpStatus));
  }

  // External API layer
  if (routeSrc) {
    const extLayer = analyzeExternalLayer(routeSrc, httpStatus);
    if (extLayer) layers.push(extLayer);
  }

  const { brokenLayer, diagnosis, fixFile, fixHint } = buildDiagnosis(layers, httpStatus, path);

  return {
    failingPath: path,
    httpStatus,
    brokenLayer,
    layers,
    diagnosis,
    fixFile,
    fixHint,
  };
}

export function formatFlowTrace(trace: FlowTrace): string {
  const lines: string[] = [`**Flow trace: ${trace.failingPath} → HTTP ${trace.httpStatus}**`];
  for (const layer of trace.layers) {
    const icon = layer.status === 'ok' ? '✅' : layer.status === 'broken' ? '❌' : layer.status === 'warning' ? '⚠️' : '❔';
    lines.push(`${icon} ${layer.label}: ${layer.evidence.slice(0, 100)}`);
  }
  lines.push('');
  lines.push(`**Diagnosis:** ${trace.diagnosis}`);
  if (trace.fixHint) lines.push(`**Fix:** ${trace.fixHint}`);
  return lines.join('\n');
}
