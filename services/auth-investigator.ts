/**
 * Auth Architecture Investigation Engine
 *
 * Solves the "individual file repair" problem: when multiple auth routes fail,
 * the repair loop sends all errors to the AI at once. The AI patches each
 * file in isolation without understanding shared dependencies — so a broken
 * db adapter makes every route fail, but the AI rewrites each route rather
 * than fixing the one shared root cause.
 *
 * This service:
 *  1. Discovers every auth-related file in the project
 *  2. Parses imports/exports to build a real dependency graph
 *  3. Detects the auth provider (custom JWT, NextAuth, Cognito, Supabase…)
 *  4. Cross-references TypeScript errors with the dependency graph
 *  5. Identifies root-cause files (those whose breakage cascades to many routes)
 *  6. Produces an ordered RepairPlan: fix root causes first, then dependents
 *
 * The RepairPlan is executed one step at a time — each step targets exactly
 * one file, with only that file's relevant context.
 */

import { readFile } from 'fs/promises';
import { join, resolve, dirname, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthProvider =
  | 'next-auth'
  | 'cognito'
  | 'supabase'
  | 'firebase'
  | 'custom-jwt'
  | 'custom-session'
  | 'unknown';

export interface AuthFileInfo {
  /** Path relative to projectPath */
  rel: string;
  /** Role this file plays in the auth system */
  role: 'route' | 'middleware' | 'db-adapter' | 'token-helper' | 'config' | 'types' | 'client-hook';
  /** Local imports (other project files this file depends on) */
  localDeps: string[];
  /** Named exports from this file */
  namedExports: string[];
  /** TypeScript errors in this file (from tsc --noEmit) */
  tsErrors: string[];
  /** Whether this file is missing from disk */
  missing: boolean;
  /** Whether any of its localDeps are missing or broken */
  hasBrokenDeps: boolean;
}

export interface RepairStep {
  stepNumber: number;
  title: string;
  /** The one file to fix in this step */
  targetFile: string;
  /** Files to include as read-only context (direct dependencies) */
  contextFiles: string[];
  /** Only the TS errors belonging to targetFile */
  tsErrors: string[];
  /** Brief instruction to pass to the repair agent */
  repairHint: string;
  /** Expected verification approach after applying the fix */
  verifyWith: 'tsc' | 'tsc+route';
  /** The route URL to hit when verifyWith === 'tsc+route' */
  verifyRoute?: string;
}

export interface AuthHealthCheck {
  flow: 'login' | 'logout' | 'me' | 'register' | 'forgot-password' | 'session';
  routeFile: string;
  routeUrl: string;
  healthy: boolean;
  missingDeps: string[];
  tsErrors: string[];
}

export interface AuthArchitectureReport {
  provider: AuthProvider;
  authFiles: AuthFileInfo[];
  /** file → files it directly depends on (within project) */
  dependencyGraph: Record<string, string[]>;
  /** Ordered list of files to fix (leaves of dep graph first) */
  repairOrder: string[];
  repairSteps: RepairStep[];
  healthChecks: AuthHealthCheck[];
  /** Human-readable summary for debug display */
  summary: string;
}

// ─── Auth file discovery ──────────────────────────────────────────────────────

/**
 * Walk a directory and return all .ts/.tsx files (relative to projectPath).
 */
async function walkDir(dir: string, base: string): Promise<string[]> {
  const { readdir } = await import('fs/promises');
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(base, full);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        results.push(...(await walkDir(full, base)));
      } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
        results.push(rel);
      }
    }
  } catch { /* dir not found */ }
  return results;
}

async function fileExists(p: string): Promise<boolean> {
  try { await readFile(p); return true; } catch { return false; }
}

/**
 * Find all files that participate in the auth system.
 */
async function discoverAuthFiles(projectPath: string): Promise<string[]> {
  const candidates: Set<string> = new Set();

  // Auth routes — the primary failure sites
  const authRoutes = await walkDir(join(projectPath, 'app', 'api', 'auth'), projectPath);
  authRoutes.forEach(f => candidates.add(f));

  // Next.js middleware
  for (const mw of ['middleware.ts', 'middleware.tsx', 'src/middleware.ts']) {
    if (await fileExists(join(projectPath, mw))) candidates.add(mw);
  }

  // Known auth helper locations
  const helperCandidates = [
    'lib/managed/auth.ts',
    'lib/managed/db.ts',
    'lib/auth.ts',
    'lib/auth.tsx',
    'lib/session.ts',
    'lib/token.ts',
    'lib/jwt.ts',
    'utils/auth.ts',
    'utils/token.ts',
    'app/lib/auth.ts',
  ];
  for (const h of helperCandidates) {
    if (await fileExists(join(projectPath, h))) candidates.add(h);
  }

  // Also scan lib/ for any file with 'auth' in its name
  const libFiles = await walkDir(join(projectPath, 'lib'), projectPath);
  for (const f of libFiles) {
    if (/auth|session|token|jwt|password/i.test(f)) candidates.add(f);
  }

  return [...candidates];
}

// ─── Import/export parsing ────────────────────────────────────────────────────

const IMPORT_RE = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/g;
const EXPORT_NAMED_RE = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
const EXPORT_REEXPORT_RE = /export\s+\{([^}]+)\}/g;
const EXPORT_DEFAULT_RE = /export\s+default\s+/;

/**
 * Resolve an import specifier to a project-relative path.
 * Returns null for node_modules.
 */
function resolveImport(
  spec: string,
  importerDir: string,
  projectPath: string,
): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;

  let abs: string;
  if (spec.startsWith('@/')) {
    abs = join(projectPath, spec.slice(2));
  } else {
    abs = resolve(importerDir, spec);
  }

  const rel = relative(projectPath, abs);
  // Normalise: if no extension, try .ts then .tsx
  if (!/\.(ts|tsx|js|jsx)$/.test(rel)) {
    return rel + '.ts'; // we'll check existence later
  }
  return rel;
}

function extractLocalImports(content: string, importerRel: string, projectPath: string): string[] {
  const importerDir = join(projectPath, dirname(importerRel));
  const deps: Set<string> = new Set();
  let m: RegExpExecArray | null;

  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const resolved = resolveImport(m[1], importerDir, projectPath);
    if (resolved) deps.add(resolved);
  }

  return [...deps];
}

function extractNamedExports(content: string): string[] {
  const exports: string[] = [];
  let m: RegExpExecArray | null;

  EXPORT_NAMED_RE.lastIndex = 0;
  while ((m = EXPORT_NAMED_RE.exec(content)) !== null) exports.push(m[1]);

  EXPORT_REEXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_REEXPORT_RE.exec(content)) !== null) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop()?.trim() ?? '').filter(Boolean);
    exports.push(...names);
  }

  if (EXPORT_DEFAULT_RE.test(content)) exports.push('default');

  return [...new Set(exports)];
}

// ─── Auth provider detection ──────────────────────────────────────────────────

function detectProvider(allContent: string): AuthProvider {
  if (/from\s+['"]next-auth['"]|import\s+NextAuth/.test(allContent)) return 'next-auth';
  if (/amazon-cognito-identity-js|@aws-amplify|CognitoUser|CognitoUserPool/.test(allContent)) return 'cognito';
  if (/from\s+['"]@supabase\/supabase-js['"]|createClient.*supabase/.test(allContent)) return 'supabase';
  if (/from\s+['"]firebase['"]|initializeApp.*firebase/.test(allContent)) return 'firebase';
  if (/from\s+['"]jsonwebtoken['"]|from\s+['"]jose['"]|jwt\.sign|jwt\.verify|SignJWT/.test(allContent)) return 'custom-jwt';
  if (/getSession|destroySession|withIronSession|iron-session/.test(allContent)) return 'custom-session';
  return 'unknown';
}

// ─── TypeScript error parsing ─────────────────────────────────────────────────

/**
 * Parse `tsc --noEmit` output into per-file error maps.
 */
async function getTsErrorsByFile(projectPath: string): Promise<Map<string, string[]>> {
  const byFile = new Map<string, string[]>();
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1', {
      cwd: projectPath, timeout: 60_000,
    });
    const lines = (stdout + stderr).split('\n');
    for (const line of lines) {
      // Format: some/path.ts(10,5): error TS2339: ...
      const m = /^(.+?\.tsx?)\(\d+,\d+\):\s+error/.exec(line);
      if (!m) continue;
      const rel = relative(projectPath, resolve(projectPath, m[1]));
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel)!.push(line.trim());
    }
  } catch (e: unknown) {
    const out = (e instanceof Error && 'stdout' in e) ? String((e as {stdout?: string}).stdout ?? '') : '';
    for (const line of out.split('\n')) {
      const m = /^(.+?\.tsx?)\(\d+,\d+\):\s+error/.exec(line);
      if (!m) continue;
      const rel = relative(projectPath, resolve(projectPath, m[1]));
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel)!.push(line.trim());
    }
  }
  return byFile;
}

// ─── Role classification ──────────────────────────────────────────────────────

function classifyRole(rel: string, content: string): AuthFileInfo['role'] {
  if (/^middleware\.(ts|tsx)$/.test(rel)) return 'middleware';
  if (/lib\/managed\/db\.ts$/.test(rel)) return 'db-adapter';
  if (/\/route\.(ts|tsx)$/.test(rel)) return 'route';
  if (/auth\.(ts|tsx)$/.test(rel) && /sign|verify|token|jwt|bcrypt|password/i.test(content)) return 'token-helper';
  if (/hook|use[A-Z]/.test(rel)) return 'client-hook';
  if (/type|interface|schema/i.test(rel)) return 'types';
  if (/config|option/i.test(rel)) return 'config';
  return 'token-helper';
}

// ─── Health checks ────────────────────────────────────────────────────────────

const AUTH_FLOWS: Array<{
  flow: AuthHealthCheck['flow'];
  patterns: RegExp[];
  defaultUrl: string;
}> = [
  { flow: 'login',           patterns: [/api\/auth\/login/, /api\/auth\/signin/],          defaultUrl: '/api/auth/login'  },
  { flow: 'logout',          patterns: [/api\/auth\/logout/, /api\/auth\/signout/],        defaultUrl: '/api/auth/logout' },
  { flow: 'me',              patterns: [/api\/auth\/me/, /api\/auth\/session/, /api\/me/], defaultUrl: '/api/auth/me'     },
  { flow: 'register',        patterns: [/api\/auth\/register/, /api\/auth\/signup/],       defaultUrl: '/api/auth/register' },
  { flow: 'forgot-password', patterns: [/api\/auth\/forgot/, /api\/auth\/reset/],         defaultUrl: '/api/auth/forgot-password' },
];

function buildHealthChecks(
  authFiles: AuthFileInfo[],
  tsErrorsByFile: Map<string, string[]>,
): AuthHealthCheck[] {
  return AUTH_FLOWS.map(({ flow, patterns, defaultUrl }) => {
    const routeFile = authFiles.find(f =>
      f.role === 'route' && patterns.some(p => p.test(f.rel))
    );

    if (!routeFile) {
      return {
        flow,
        routeFile: '',
        routeUrl: defaultUrl,
        healthy: false,
        missingDeps: [],
        tsErrors: [],
      };
    }

    const missingDeps = routeFile.localDeps.filter(dep => {
      const depFile = authFiles.find(f => f.rel === dep || f.rel.replace(/\.ts$/, '') === dep.replace(/\.ts$/, ''));
      return depFile?.missing ?? true;
    });

    const fileErrors = tsErrorsByFile.get(routeFile.rel) ?? [];
    const depErrors = routeFile.localDeps.flatMap(dep => tsErrorsByFile.get(dep) ?? []);

    return {
      flow,
      routeFile: routeFile.rel,
      routeUrl: defaultUrl,
      healthy: fileErrors.length === 0 && depErrors.length === 0 && missingDeps.length === 0 && !routeFile.missing,
      missingDeps,
      tsErrors: fileErrors,
    };
  });
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Topological sort (Kahn's algorithm).
 * Returns files in dependency order: files with no deps (or only healthy deps) come first.
 * Only includes files that have errors or broken deps.
 */
function topologicalSort(
  brokenFiles: string[],
  graph: Record<string, string[]>,
): string[] {
  const brokenSet = new Set(brokenFiles);

  // in-degree = number of broken dependencies THIS file has
  // (files with 0 broken deps are root causes → fix first)
  const inDegree = new Map<string, number>();
  // reversed edges: dep → list of files that depend on dep
  const dependents = new Map<string, string[]>();

  for (const file of brokenFiles) {
    const brokenDeps = (graph[file] ?? []).filter(d => brokenSet.has(d));
    inDegree.set(file, brokenDeps.length);

    for (const dep of brokenDeps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(file);
    }
  }

  // Start with files that have no broken dependencies (root causes)
  const queue = brokenFiles.filter(f => (inDegree.get(f) ?? 0) === 0);
  const result: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    result.push(file);

    // Decrement in-degree of files that depend on the one we just "fixed"
    for (const dependent of (dependents.get(file) ?? [])) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // Append any remaining (circular dependency — rare)
  for (const f of brokenFiles) {
    if (!result.includes(f)) result.push(f);
  }

  return result;
}

// ─── Repair hint generation ───────────────────────────────────────────────────

function buildRepairHint(file: AuthFileInfo, provider: AuthProvider, allFiles: AuthFileInfo[]): string {
  const role = file.role;
  const hints: string[] = [`Fix the TypeScript errors in ${file.rel}.`];

  if (role === 'db-adapter') {
    hints.push('This is the database adapter — exported functions (db.get, db.all, db.run) must match exactly what auth routes import.');
    hints.push('Use the { all, get, run } wrapper pattern. Never export a raw Database instance.');
  }

  if (role === 'token-helper') {
    hints.push('This file is the auth token/JWT helper. Ensure exported functions (getAuthUser, signToken, verifyToken) are exported correctly and return the documented types.');
    if (provider === 'custom-jwt') hints.push('Use the jsonwebtoken or jose library correctly. Ensure JWT_SECRET is read from env.');
  }

  if (role === 'route') {
    const brokenDeps = file.localDeps.filter(dep => {
      const depFile = allFiles.find(f => f.rel === dep);
      return depFile && (depFile.tsErrors.length > 0 || depFile.missing);
    });
    if (brokenDeps.length > 0) {
      hints.push(`Note: dependencies ${brokenDeps.join(', ')} were already repaired in earlier steps — import from them correctly.`);
    }
    hints.push('Ensure: await getAuthUser(request) (never without await), use auth.sub not auth.userId, wrap in try/catch, return NextResponse.json.');
  }

  if (role === 'middleware') {
    hints.push('Middleware runs on every request — check token without calling DB. Use the same token verification as the auth helper.');
  }

  if (file.missing) {
    hints.push(`⚠️ This file does not exist — it needs to be CREATED, not just fixed.`);
  }

  return hints.join(' ');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run Architecture Investigation Mode on the auth system.
 *
 * Returns a structured report with:
 * - What files are involved
 * - Who depends on whom
 * - What is broken and why
 * - An ordered repair plan: fix root causes first, dependents after
 */
export async function investigateAuthArchitecture(
  projectPath: string,
  externalTsErrors?: string[],
): Promise<AuthArchitectureReport> {

  // 1. Discover all auth-related files
  const fileRels = await discoverAuthFiles(projectPath);

  // 2. Read each file and parse its structure
  const tsErrorsByFile = await getTsErrorsByFile(projectPath);

  // Also add any externally-provided errors (e.g. from pre-repair diagnostics)
  if (externalTsErrors?.length) {
    for (const line of externalTsErrors) {
      const m = /^(.+?\.tsx?)\(\d+,\d+\):\s+error/.exec(line);
      if (!m) continue;
      const rel = relative(projectPath, resolve(projectPath, m[1]));
      if (!tsErrorsByFile.has(rel)) tsErrorsByFile.set(rel, []);
      tsErrorsByFile.get(rel)!.push(line.trim());
    }
  }

  let allContent = '';
  const authFiles: AuthFileInfo[] = [];

  for (const rel of fileRels) {
    const absPath = join(projectPath, rel);
    let content = '';
    let missing = false;

    try {
      content = await readFile(absPath, 'utf-8');
      allContent += content;
    } catch {
      missing = true;
    }

    const localDeps = missing ? [] : extractLocalImports(content, rel, projectPath);
    const namedExports = missing ? [] : extractNamedExports(content);
    const role = missing ? 'route' : classifyRole(rel, content);
    const tsErrors = tsErrorsByFile.get(rel) ?? [];

    authFiles.push({
      rel,
      role,
      localDeps,
      namedExports,
      tsErrors,
      missing,
      hasBrokenDeps: false, // computed next
    });
  }

  // 3. Mark files with broken deps
  for (const f of authFiles) {
    f.hasBrokenDeps = f.localDeps.some(dep => {
      const depFile = authFiles.find(d => d.rel === dep || d.rel.replace(/\.ts$/, '') === dep.replace(/\.ts$/, ''));
      return depFile ? (depFile.missing || depFile.tsErrors.length > 0) : false;
    });
  }

  // 4. Build dependency graph
  const dependencyGraph: Record<string, string[]> = {};
  for (const f of authFiles) {
    dependencyGraph[f.rel] = f.localDeps.filter(dep =>
      authFiles.some(d => d.rel === dep || d.rel.replace(/\.ts$/, '') === dep.replace(/\.ts$/, ''))
    );
  }

  // 5. Detect auth provider
  const provider = detectProvider(allContent);

  // 6. Find broken files (have errors OR are missing)
  const brokenFiles = authFiles
    .filter(f => f.missing || f.tsErrors.length > 0)
    .map(f => f.rel);

  // 7. Topological sort → repair order
  const repairOrder = topologicalSort(brokenFiles, dependencyGraph);

  // 8. Generate repair steps
  const repairSteps: RepairStep[] = repairOrder.map((rel, i) => {
    const file = authFiles.find(f => f.rel === rel)!;
    const contextFiles = (dependencyGraph[rel] ?? [])
      .filter(dep => authFiles.find(d => d.rel === dep && !d.missing))
      .slice(0, 4); // don't overwhelm the context

    const routeUrl = (() => {
      const flow = AUTH_FLOWS.find(af => af.patterns.some(p => p.test(rel)));
      return flow?.defaultUrl;
    })();

    return {
      stepNumber: i + 1,
      title: file.missing
        ? `Create missing ${rel}`
        : `Fix ${file.role} ${rel} (${file.tsErrors.length} error${file.tsErrors.length !== 1 ? 's' : ''})`,
      targetFile: rel,
      contextFiles,
      tsErrors: file.tsErrors,
      repairHint: buildRepairHint(file, provider, authFiles),
      verifyWith: routeUrl ? 'tsc+route' : 'tsc',
      verifyRoute: routeUrl,
    };
  });

  // 9. Build health checks
  const healthChecks = buildHealthChecks(authFiles, tsErrorsByFile);

  // 10. Generate summary
  const brokenCount = brokenFiles.length;
  const providerLabel = provider === 'unknown' ? 'custom' : provider;
  const rootCauses = repairOrder.slice(0, 3); // first files in order = root causes
  const summary = [
    `Auth provider: ${providerLabel}`,
    `Broken files: ${brokenCount} (${brokenFiles.slice(0, 3).join(', ')}${brokenFiles.length > 3 ? '…' : ''})`,
    rootCauses.length > 0 ? `Root causes (fix first): ${rootCauses.join(' → ')}` : 'No broken auth files detected',
    `Repair steps: ${repairSteps.length}`,
    `Unhealthy flows: ${healthChecks.filter(h => !h.healthy).map(h => h.flow).join(', ') || 'none'}`,
  ].join('\n');

  return {
    provider,
    authFiles,
    dependencyGraph,
    repairOrder,
    repairSteps,
    healthChecks,
    summary,
  };
}
