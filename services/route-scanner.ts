/**
 * Route Scanner
 *
 * Scans a generated project's source files for every navigation target
 * (Link href, router.push, redirect, a href, window.location) and checks
 * whether each target has a real Next.js page.tsx file.
 *
 * "The UI renders but clicking any link returns 404" happens when the builder
 * creates navigation without creating the matching page routes. This service
 * detects and reports every such gap so it can be auto-repaired.
 *
 * Usage:
 *   const result = await scanMissingRoutes(projectPath);
 *   // result.missing: string[] — routes referenced in UI but no page exists
 *   // result.all: string[]    — all routes referenced in UI (for HTTP check)
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteReference {
  route: string;      // e.g. "/login"
  sourceFile: string; // relative path of the file that references it
  line: number;
  context: string;    // surrounding code snippet
}

export interface RouteScanResult {
  /** All unique route paths referenced in UI source files */
  referencedRoutes: string[];
  /** Routes that have a matching page.tsx (or route-group equivalent) */
  existingRoutes: string[];
  /** Routes referenced in the UI but missing a page file — the 404s */
  missingRoutes: string[];
  /** Full reference details for all missing routes */
  missingDetails: RouteReference[];
  /** Route group directories found in app/ (e.g. "(auth)", "(marketing)") */
  routeGroups: string[];
  /** Dynamic routes detected via template literals (e.g. `/property/${id}`) */
  dynamicRouteHints: DynamicRouteHint[];
  /** Dynamic route page files that are missing (need to be created) */
  missingDynamicPageFiles: string[];
}

export interface RouteReachabilityResult {
  route: string;
  statusCode: number;
  ok: boolean;
}

// ─── Navigation target extraction ────────────────────────────────────────────

// Patterns that capture a route path string from navigation code
const NAV_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // <Link href="/path"> or <Link href={'/path'}>
  { re: /\bhref\s*=\s*["'`](\/[^"'`?#\s]{0,60})["'`]/g, group: 1 },
  // router.push('/path') — all router/navigate variants
  { re: /(?:router|navigate|useRouter\(\))\.(?:push|replace)\(\s*["'`](\/[^"'`?#\s]{0,60})["'`]/g, group: 1 },
  // redirect('/path') and permanentRedirect('/path')
  { re: /(?:permanentR|r)edirect\(\s*["'`](\/[^"'`?#\s]{0,60})["'`]/g, group: 1 },
  // window.location.href = '/path' or window.location = '/path'
  { re: /window\.location(?:\.href)?\s*=\s*["'`](\/[^"'`?#\s]{0,60})["'`]/g, group: 1 },
  // push('/path') — bare router push (common in useRouter pattern)
  { re: /\bpush\(\s*["'`](\/[a-z][a-z0-9\-/]{0,50})["'`]/g, group: 1 },
  // Navigation arrays: { href: '/path' } or { to: '/path' } or { path: '/path' }
  { re: /(?:href|to|path|route)\s*:\s*["'`](\/[a-z][a-z0-9\-/]{0,50})["'`]/g, group: 1 },
];

// Paths to skip — not page routes
const SKIP_PREFIXES = ['/api/', '/_next/', '/static/', '/public/'];
const SKIP_PATTERNS = [/\.[a-zA-Z0-9]{1,5}$/, /^\/api\//];

function isPageRoute(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path === '/') return true;
  if (SKIP_PREFIXES.some(p => path.startsWith(p))) return false;
  if (SKIP_PATTERNS.some(re => re.test(path))) return false;
  return true;
}

// ─── Dynamic route detection ──────────────────────────────────────────────────
// Detect template literal navigation like: href={`/property/${id}`}
// and convert them to dynamic route patterns like: /property/[id]

const TEMPLATE_LITERAL_PATTERNS: RegExp[] = [
  // href={`/property/${id}`}  or  href={`/listings/${listing.id}`}
  /href\s*=\s*\{`(\/[a-z0-9\-/]*)\$\{[^}]+\}[^`]*`\}/gi,
  // router.push(`/property/${id}`)
  /(?:router|navigate)\.(?:push|replace)\(`(\/[a-z0-9\-/]*)\$\{[^}]+\}`\)/gi,
  // push(`/path/${id}`)
  /\bpush\(`(\/[a-z0-9\-/]*)\$\{[^}]+\}`\)/gi,
];

export interface DynamicRouteHint {
  /** Route pattern, e.g. "/property/[id]" */
  routePattern: string;
  /** Suggested file path, e.g. "app/property/[id]/page.tsx" */
  pageFile: string;
  /** Source file that contains the navigation */
  sourceFile: string;
}

export function extractDynamicRouteHints(content: string, sourceFile: string): DynamicRouteHint[] {
  const hints: DynamicRouteHint[] = [];

  for (const pattern of TEMPLATE_LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const baseSegment = m[1].replace(/\/$/, ''); // e.g. "/property"
      if (!baseSegment || baseSegment.startsWith('/api')) continue;

      // Determine whether the dynamic segment is an id or a slug
      // Look at the variable name in the template: ${id} → id, ${listing.id} → id, ${slug} → slug
      const varMatch = m[0].match(/\$\{([^}]+)\}/);
      const varName = varMatch ? varMatch[1].split('.').pop() ?? 'id' : 'id';
      const paramName = varName === 'slug' ? 'slug' : 'id';

      const routePattern = `${baseSegment}/[${paramName}]`;
      const pageFile = `app${routePattern}/page.tsx`;

      if (!hints.some(h => h.pageFile === pageFile)) {
        hints.push({ routePattern, pageFile, sourceFile });
      }
    }
  }

  return hints;
}

function extractNavigationTargets(content: string, sourceFile: string): RouteReference[] {
  const refs: RouteReference[] = [];
  const lines = content.split('\n');

  for (const { re, group } of NAV_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const route = m[group];
      if (!isPageRoute(route)) continue;

      // Find line number
      const offset = m.index;
      let lineNum = 1;
      let pos = 0;
      for (const line of lines) {
        if (pos + line.length >= offset) break;
        pos += line.length + 1;
        lineNum++;
      }

      refs.push({
        route,
        sourceFile,
        line: lineNum,
        context: m[0].trim().slice(0, 80),
      });
    }
  }

  return refs;
}

// ─── Page existence check ─────────────────────────────────────────────────────

async function findRouteGroups(appDir: string): Promise<string[]> {
  const groups: string[] = [];
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^\([^)]+\)$/.test(e.name)) groups.push(e.name);
    }
  } catch { /* no app dir */ }
  return groups;
}

async function pageFileExists(appDir: string, route: string, groups: string[]): Promise<boolean> {
  const routeParts = route.replace(/^\//, '').replace(/\/$/, '');
  const exts = ['page.tsx', 'page.ts', 'page.jsx', 'page.js'];

  // Check direct path: app/login/page.tsx
  for (const ext of exts) {
    try {
      await readFile(join(appDir, routeParts, ext), 'utf-8');
      return true;
    } catch { /* try next */ }
  }

  // Check under each route group: app/(auth)/login/page.tsx
  for (const group of groups) {
    for (const ext of exts) {
      try {
        await readFile(join(appDir, group, routeParts, ext), 'utf-8');
        return true;
      } catch { /* try next */ }
    }
  }

  // Root-level page (route === '/')
  if (route === '/') {
    for (const ext of exts) {
      try {
        await readFile(join(appDir, ext), 'utf-8');
        return true;
      } catch { /* try next */ }
    }
  }

  return false;
}

// ─── File scanner ─────────────────────────────────────────────────────────────

const SCAN_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'out', '__pycache__']);

async function scanSourceFiles(projectPath: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);

      if (e.isDirectory()) {
        // Only scan app/ and components/ and src/ — API routes don't have nav
        if (e.name === 'api') continue;
        await walk(abs);
      } else if (e.isFile()) {
        const ext = e.name.substring(e.name.lastIndexOf('.'));
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        try {
          const content = await readFile(abs, 'utf-8');
          files.push({ path: relative(projectPath, abs), content });
        } catch { /* skip */ }
      }
    }
  }

  await walk(join(projectPath, 'app'));
  // Also scan components if it exists
  await walk(join(projectPath, 'components'));
  await walk(join(projectPath, 'src'));

  return files;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function scanMissingRoutes(projectPath: string): Promise<RouteScanResult> {
  const appDir = join(projectPath, 'app');
  const routeGroups = await findRouteGroups(appDir);

  // Scan all source files
  const sourceFiles = await scanSourceFiles(projectPath);

  // Extract all navigation targets (static routes)
  const allRefs: RouteReference[] = [];
  // Extract dynamic route hints (template literal navigation)
  const allDynamicHints: DynamicRouteHint[] = [];

  for (const { path, content } of sourceFiles) {
    allRefs.push(...extractNavigationTargets(content, path));
    allDynamicHints.push(...extractDynamicRouteHints(content, path));
  }

  // Deduplicate static routes by route
  const routeMap = new Map<string, RouteReference>();
  for (const ref of allRefs) {
    if (!routeMap.has(ref.route)) routeMap.set(ref.route, ref);
  }

  const referencedRoutes = [...routeMap.keys()].sort();

  // Check which static routes have page files
  const existingRoutes: string[] = [];
  const missingRoutes: string[] = [];
  const missingDetails: RouteReference[] = [];

  for (const route of referencedRoutes) {
    const exists = await pageFileExists(appDir, route, routeGroups);
    if (exists) {
      existingRoutes.push(route);
    } else {
      missingRoutes.push(route);
      missingDetails.push(routeMap.get(route)!);
    }
  }

  // Check which dynamic route pages are missing
  const { readFile: rf } = await import('fs/promises');
  const missingDynamicPageFiles: string[] = [];
  for (const hint of allDynamicHints) {
    try {
      await rf(join(projectPath, hint.pageFile), 'utf-8');
      // File exists — not missing
    } catch {
      if (!missingDynamicPageFiles.includes(hint.pageFile)) {
        missingDynamicPageFiles.push(hint.pageFile);
      }
    }
  }

  return {
    referencedRoutes,
    existingRoutes,
    missingRoutes,
    missingDetails,
    routeGroups,
    dynamicRouteHints: allDynamicHints,
    missingDynamicPageFiles,
  };
}

// ─── HTTP reachability check ──────────────────────────────────────────────────

export async function checkRouteReachability(
  port: number,
  routes: string[],
): Promise<RouteReachabilityResult[]> {
  const results = await Promise.all(
    routes.map(async route => {
      try {
        const res = await fetch(`http://localhost:${port}${route}`, {
          signal: AbortSignal.timeout(6000),
          headers: { Accept: 'text/html' },
          redirect: 'follow',
        });
        return { route, statusCode: res.status, ok: res.status !== 404 && res.status < 500 };
      } catch {
        return { route, statusCode: 0, ok: false };
      }
    }),
  );
  return results;
}

// ─── Static route repair (deterministic, no AI) ───────────────────────────────
// For each missing static route, creates the right file immediately:
//   - Auth-related routes (login, signup, register, signin) → redirect('/auth') if
//     /auth page exists, otherwise redirect('/') as safe fallback
//   - Other missing routes → plain page stub
// Returns the list of relative file paths that were created.

export async function repairStaticRoutes(
  projectPath: string,
  missingRoutes: string[],
  existingRoutes: string[],
): Promise<{ created: string[]; redirected: string[]; stubbed: string[] }> {
  const { writeFile: wf, mkdir } = await import('fs/promises');
  const { dirname } = await import('path');

  const appDir = join(projectPath, 'app');
  const routeGroups = await findRouteGroups(appDir);
  const created: string[] = [];
  const redirected: string[] = [];
  const stubbed: string[] = [];

  const AUTH_ROUTES = /^(login|signin|sign-in|log-in|signup|sign-up|register|create-account|forgot-password|reset-password|logout|log-out|sign-out)$/;

  // Detect the real auth page — could be /auth, /login (already exists), etc.
  const authTarget =
    existingRoutes.includes('/auth') ? '/auth' :
    existingRoutes.includes('/login') ? '/login' :
    existingRoutes.includes('/signin') ? '/signin' :
    null;

  for (const route of missingRoutes) {
    const segment = route.replace(/^\//, '');
    const filePath = bestPagePath(route, routeGroups, appDir);
    const name = segment
      .split(/[-/]/)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('') || 'Home';

    let content: string;

    if (AUTH_ROUTES.test(segment) && authTarget && authTarget !== route) {
      // Redirect to the real auth page
      content = `import { redirect } from 'next/navigation';\n\nexport default function ${name}Page() {\n  redirect('${authTarget}');\n}\n`;
      redirected.push(route);
    } else {
      // Plain stub — will be enhanced by AI later if needed
      content = `export default function ${name}Page() {\n  return (\n    <main className="min-h-screen flex flex-col items-center justify-center p-8">\n      <div className="max-w-md w-full text-center">\n        <h1 className="text-3xl font-bold mb-4">${name}</h1>\n        <p className="text-gray-500">This page is coming soon.</p>\n      </div>\n    </main>\n  );\n}\n`;
      stubbed.push(route);
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await wf(filePath, content, 'utf-8');
      created.push(filePath.replace(projectPath + '/', ''));
    } catch { /* skip if can't write */ }
  }

  return { created, redirected, stubbed };
}

// ─── Page stub generator (deterministic fallback) ─────────────────────────────
// These are used when AI generation is not available or for instant stubs.

export function generatePageStub(route: string, projectContext: string): string {
  const name = route
    .split('/')
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') || 'Home';

  // Detect if the project uses 'use client' pattern
  const usesClient = /['"]use client['"]/i.test(projectContext);

  return `${usesClient ? "'use client';\n\n" : ''}export default function ${name}Page() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <h1 className="text-3xl font-bold mb-4">${name}</h1>
        <p className="text-gray-600">This page is under construction.</p>
      </div>
    </main>
  );
}
`;
}

// ─── Page placement helper ────────────────────────────────────────────────────
// Returns the best file path to create for a given route,
// respecting existing route groups (e.g. puts /login in app/(auth)/login/page.tsx
// if an (auth) group already exists in the project).

export function bestPagePath(
  route: string,
  routeGroups: string[],
  appDir: string,
): string {
  const segment = route.replace(/^\//, '').replace(/\/$/, '');

  // Auth-related routes → (auth) group if it exists
  const isAuth = /^(?:login|signin|signup|register|forgot-password|reset-password|verify|logout)/.test(segment);
  if (isAuth) {
    const authGroup = routeGroups.find(g => /auth|account/i.test(g));
    if (authGroup) return join(appDir, authGroup, segment, 'page.tsx');
  }

  // Marketing routes → (marketing) group if it exists
  const isMkt = /^(?:about|contact|pricing|faq|terms|privacy|landing)/.test(segment);
  if (isMkt) {
    const mktGroup = routeGroups.find(g => /marketing|public|landing/i.test(g));
    if (mktGroup) return join(appDir, mktGroup, segment, 'page.tsx');
  }

  // Default: top-level
  return join(appDir, segment, 'page.tsx');
}
