/**
 * Project Understanding Engine — ProjectMap
 *
 * Builds a complete structural map of a generated project in ~2-3 seconds.
 * No AI call. Pure file-system reads and regex.
 *
 * The project map is the foundation for root-cause identification. Without
 * it, the repair system treats every error in isolation. With it, it can
 * answer: "Which file is the common upstream dependency of all these errors?"
 *
 * Saved to .dwomoh/project-map.json so subsequent repair steps don't re-scan.
 */

import { readFile, writeFile, readdir, mkdir, access } from 'fs/promises';
import { join, relative, resolve, dirname } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FileLayer =
  | 'ui'          // page.tsx, layout.tsx
  | 'component'   // components/**
  | 'api'         // app/api/**/route.ts
  | 'data'        // lib/data/*, lib/managed/*
  | 'auth'        // lib/auth.ts, middleware.ts
  | 'config'      // next.config*, tsconfig*, .env*
  | 'types'       // lib/types/**
  | 'services'    // services/**
  | 'hooks'       // hooks/**, lib/hooks/**
  | 'middleware'  // middleware.ts
  | 'unknown';

export interface FileInfo {
  path: string;       // relative from project root
  layer: FileLayer;
  imports: string[];  // resolved relative paths this file imports
  size: number;
}

export interface RouteInfo {
  url: string;
  file: string;       // relative path
  methods: string[];
  routeGroup?: string;
  isApi: boolean;
}

export interface ProjectMap {
  projectPath: string;
  scannedAt: number;

  files: FileInfo[];
  layers: Record<FileLayer, string[]>;

  /** file → files it imports (relative paths) */
  importGraph: Record<string, string[]>;
  /** file → files that import it (reverse index) */
  exportGraph: Record<string, string[]>;

  routes: RouteInfo[];

  envVarsReferenced: string[];
  envVarsAvailable: string[];
  envVarsMissing: string[];

  dbFile: string | null;
  dbTables: string[];

  authProvider: 'cognito' | 'nextauth' | 'custom' | 'none';
  authFiles: string[];
  middlewareFile: string | null;

  packageDeps: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.turbo', '.dwomoh']);
const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/;

// ─── File layer classification ────────────────────────────────────────────────

function classifyLayer(relPath: string): FileLayer {
  if (relPath === 'middleware.ts' || relPath === 'middleware.js') return 'middleware';
  if (relPath.startsWith('app/api/')) return 'api';
  if (/^app\/.*page\.(tsx|ts|jsx|js)$/.test(relPath)) return 'ui';
  if (/^app\/.*layout\.(tsx|ts|jsx|js)$/.test(relPath)) return 'ui';
  if (relPath.startsWith('components/') || relPath.startsWith('app/components/')) return 'component';
  if (relPath.startsWith('lib/data/') || relPath.startsWith('lib/managed/')) return 'data';
  if (/^lib\/auth/.test(relPath) || relPath === 'lib/auth.ts') return 'auth';
  if (relPath.startsWith('lib/types/') || relPath.startsWith('types/')) return 'types';
  if (relPath.startsWith('services/')) return 'services';
  if (relPath.startsWith('hooks/') || relPath.startsWith('lib/hooks/')) return 'hooks';
  if (/\.(config|env)\.(ts|js|mjs)$/.test(relPath) || /^\.env/.test(relPath)) return 'config';
  if (relPath.startsWith('app/')) return 'ui';
  if (relPath.startsWith('lib/')) return 'services';
  return 'unknown';
}

// ─── Import resolution ────────────────────────────────────────────────────────

function extractRawImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /^import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /(?:require|import)\(['"]([^'"]+)['"]\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) imports.add(m[1]);
  }
  return [...imports];
}

function resolveImport(
  fromFile: string,   // relative path of the importing file
  importPath: string,
  projectPath: string,
): string | null {
  // Skip node_modules imports (no leading . or @/)
  if (!importPath.startsWith('.') && !importPath.startsWith('@/')) return null;

  let absTarget: string;
  if (importPath.startsWith('@/')) {
    absTarget = join(projectPath, importPath.replace('@/', ''));
  } else {
    absTarget = resolve(join(projectPath, dirname(fromFile)), importPath);
  }

  // Try with various extensions
  const rel = relative(projectPath, absTarget);
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
    const candidate = rel + ext;
    if (!candidate.includes('..') && candidate.length < 200) {
      return candidate;
    }
  }
  return rel;
}

// ─── HTTP methods ─────────────────────────────────────────────────────────────

function extractHttpMethods(content: string): string[] {
  const methods: string[] = [];
  const re = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) methods.push(m[1]);
  return methods;
}

// ─── URL computation ──────────────────────────────────────────────────────────

function computeRouteUrl(relPath: string): string {
  const url = '/' + relPath
    .replace(/^app\//, '')
    .replace(/\([^)]+\)\//g, '')
    .replace(/\/route\.(ts|js)$/, '')
    .replace(/\/page\.(tsx|ts|jsx|js)$/, '')
    .replace(/^page\.(tsx|ts|jsx|js)$/, '');
  return url || '/';
}

function extractRouteGroup(relPath: string): string | undefined {
  const m = /app\/(\([^)]+\))\//.exec(relPath);
  return m ? m[1] : undefined;
}

// ─── DB table detection ───────────────────────────────────────────────────────

function extractDbTables(content: string): string[] {
  const tables: string[] = [];
  // CREATE TABLE (IF NOT EXISTS) tablename
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) tables.push(m[1].toLowerCase());
  return tables;
}

// ─── Auth provider detection ──────────────────────────────────────────────────

function detectAuthProvider(
  packageDeps: string[],
  fileContents: Map<string, string>,
): 'cognito' | 'nextauth' | 'custom' | 'none' {
  const depSet = new Set(packageDeps);
  if (depSet.has('next-auth')) return 'nextauth';
  if (depSet.has('amazon-cognito-identity-js') || depSet.has('@aws-amplify/auth') ||
      depSet.has('aws-amplify')) return 'cognito';

  // Check file contents for indicators
  for (const [, content] of fileContents) {
    if (/CognitoUser|CognitoUserPool|AuthenticationDetails/i.test(content)) return 'cognito';
    if (/NextAuth|next-auth|getServerSession/i.test(content)) return 'nextauth';
    if (/jwt\.sign|jsonwebtoken|bcrypt/i.test(content)) return 'custom';
  }

  return 'none';
}

// ─── File walker ──────────────────────────────────────────────────────────────

async function walkSourceFiles(
  dir: string,
  projectPath: string,
): Promise<Array<{ relPath: string; absPath: string }>> {
  const results: Array<{ relPath: string; absPath: string }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(projectPath, abs);
      if (e.isDirectory()) {
        results.push(...await walkSourceFiles(abs, projectPath));
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        results.push({ relPath: rel, absPath: abs });
      }
    }
  } catch { /* unreadable */ }
  return results;
}

// ─── Main build function ──────────────────────────────────────────────────────

export async function buildProjectMap(projectPath: string): Promise<ProjectMap> {
  const allFiles = await walkSourceFiles(projectPath, projectPath);
  const fileContents = new Map<string, string>();

  // Read all source files
  await Promise.all(
    allFiles.map(async ({ relPath, absPath }) => {
      try {
        const content = await readFile(absPath, 'utf-8');
        fileContents.set(relPath, content);
      } catch { /* skip */ }
    })
  );

  // Build file info + import graph
  const fileInfos: FileInfo[] = [];
  const importGraph: Record<string, string[]> = {};
  const exportGraph: Record<string, string[]> = {};

  for (const { relPath } of allFiles) {
    const content = fileContents.get(relPath) ?? '';
    const rawImports = extractRawImports(content);
    const resolvedImports = rawImports
      .map(i => resolveImport(relPath, i, projectPath))
      .filter(Boolean) as string[];

    fileInfos.push({
      path: relPath,
      layer: classifyLayer(relPath),
      imports: resolvedImports,
      size: content.length,
    });

    importGraph[relPath] = resolvedImports;
    for (const dep of resolvedImports) {
      if (!exportGraph[dep]) exportGraph[dep] = [];
      exportGraph[dep].push(relPath);
    }
  }

  // Layer index
  const layers: Record<FileLayer, string[]> = {
    ui: [], component: [], api: [], data: [], auth: [], config: [],
    types: [], services: [], hooks: [], middleware: [], unknown: [],
  };
  for (const fi of fileInfos) layers[fi.layer].push(fi.path);

  // Routes
  const routes: RouteInfo[] = [];
  for (const fi of fileInfos) {
    if (fi.layer === 'api') {
      const content = fileContents.get(fi.path) ?? '';
      routes.push({
        url: computeRouteUrl(fi.path),
        file: fi.path,
        methods: extractHttpMethods(content),
        routeGroup: extractRouteGroup(fi.path),
        isApi: true,
      });
    } else if (fi.layer === 'ui' && /page\.(tsx|ts|jsx|js)$/.test(fi.path)) {
      routes.push({
        url: computeRouteUrl(fi.path),
        file: fi.path,
        methods: [],
        routeGroup: extractRouteGroup(fi.path),
        isApi: false,
      });
    }
  }

  // Env vars
  const envVarsReferenced = new Set<string>();
  for (const content of fileContents.values()) {
    const re = /process\.env\.([A-Z][A-Z0-9_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) envVarsReferenced.add(m[1]);
  }

  const envVarsAvailable: string[] = [];
  try {
    const envContent = await readFile(join(projectPath, '.env.local'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim());
      if (match) envVarsAvailable.push(match[1]);
    }
  } catch { /* no .env.local */ }

  const availableSet = new Set(envVarsAvailable);
  const envVarsMissing = [...envVarsReferenced].filter(
    k => !availableSet.has(k) && !['NODE_ENV', 'PORT', 'HOST', 'NEXT_PUBLIC_VERCEL_URL'].includes(k)
  );

  // DB
  let dbFile: string | null = null;
  const dbTables: string[] = [];
  for (const fi of fileInfos) {
    if (fi.layer === 'data') {
      const content = fileContents.get(fi.path) ?? '';
      const tables = extractDbTables(content);
      if (tables.length > 0) {
        dbFile = fi.path;
        dbTables.push(...tables);
      }
    }
  }

  // Package deps
  let packageDeps: string[] = [];
  try {
    const pkgJson = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf-8'));
    packageDeps = [
      ...Object.keys(pkgJson.dependencies ?? {}),
      ...Object.keys(pkgJson.devDependencies ?? {}),
    ];
  } catch { /* no package.json */ }

  // Auth
  const authFiles = fileInfos.filter(fi => fi.layer === 'auth').map(fi => fi.path);
  const middlewareFile = fileInfos.find(fi => fi.layer === 'middleware')?.path ?? null;
  const authProvider = detectAuthProvider(packageDeps, fileContents);

  const map: ProjectMap = {
    projectPath,
    scannedAt: Date.now(),
    files: fileInfos,
    layers,
    importGraph,
    exportGraph,
    routes,
    envVarsReferenced: [...envVarsReferenced],
    envVarsAvailable,
    envVarsMissing,
    dbFile,
    dbTables,
    authProvider,
    authFiles,
    middlewareFile,
    packageDeps,
  };

  return map;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const MAP_FILE = '.dwomoh/project-map.json';

export async function saveProjectMap(projectPath: string, map: ProjectMap): Promise<void> {
  const dir = join(projectPath, '.dwomoh');
  await mkdir(dir, { recursive: true });
  await writeFile(join(projectPath, MAP_FILE), JSON.stringify(map, null, 2), 'utf-8');
}

export async function loadProjectMap(projectPath: string): Promise<ProjectMap | null> {
  try {
    const raw = await readFile(join(projectPath, MAP_FILE), 'utf-8');
    const map = JSON.parse(raw) as ProjectMap;
    // Invalidate if older than 5 minutes (project may have changed during repair)
    if (Date.now() - map.scannedAt > 5 * 60 * 1000) return null;
    return map;
  } catch {
    return null;
  }
}

/** Invalidate cached map (call after any file write) */
export async function invalidateProjectMap(projectPath: string): Promise<void> {
  try {
    const mapPath = join(projectPath, MAP_FILE);
    const raw = await readFile(mapPath, 'utf-8');
    const map = JSON.parse(raw) as ProjectMap;
    map.scannedAt = 0; // forces re-scan on next load
    await writeFile(mapPath, JSON.stringify(map, null, 2), 'utf-8');
  } catch { /* not cached, nothing to invalidate */ }
}

/** Get or build project map, using cache if fresh */
export async function getProjectMap(projectPath: string): Promise<ProjectMap> {
  const cached = await loadProjectMap(projectPath);
  if (cached) return cached;
  const map = await buildProjectMap(projectPath);
  await saveProjectMap(projectPath, map);
  return map;
}
