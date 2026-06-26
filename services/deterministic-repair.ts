/**
 * Deterministic Repair Engine
 *
 * Phase 1 of the repair pipeline — applies KNOWN code fixes directly, without
 * calling any AI model. Each transform is a pure code operation: read file,
 * apply regex/rewrite, write file.
 *
 * Why this matters:
 *   The AI repair loop (Haiku → Sonnet → Opus) fails for known patterns because
 *   it has to INTERPRET text instructions. A human developer doesn't interpret —
 *   they apply the exact known fix. This service replicates that behaviour.
 *
 * Adding a new transform:
 *   1. Add a TRANSFORM_ID to TRANSFORMS below
 *   2. Implement the transform function
 *   3. Add the error pattern to PATTERN_TO_TRANSFORM
 *   4. Add the builtin pattern to engineering-memory.ts BUILTIN_PATTERNS
 */

import { readFile, writeFile, readdir, rm, stat } from 'fs/promises';
import { join, relative, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeterministicFix {
  transformId: string;
  file: string;
  description: string;
}

export interface DeterministicRepairResult {
  applied: DeterministicFix[];
  skipped: string[];
  remainingTsErrors: string[];
  allFixed: boolean;
  tsOutput: string;
}

// ─── Canonical lib/managed/db.ts content ─────────────────────────────────────

const CANONICAL_DB_TS = `import Database from 'better-sqlite3';
import { join } from 'path';

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(join(process.cwd(), 'project.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initTable(sql: string): void {
  getDb().exec(sql);
}

export const db = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return getDb().prepare(sql).all(...params) as T[];
  },
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return getDb().prepare(sql).get(...params) as T | undefined;
  },
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return getDb().prepare(sql).run(...params);
  },
};
`;

// ─── Transform implementations ────────────────────────────────────────────────

/**
 * AUTH-MISSING-AWAIT
 * Pattern: "Property 'X' does not exist on type 'Promise<TokenPayload | null>'"
 * Fix: add `await` before every bare `getAuthUser(` call in API routes
 */
async function fixAuthMissingAwait(projectPath: string): Promise<DeterministicFix[]> {
  const fixes: DeterministicFix[] = [];

  // Walk app/api for route files
  const { readdir } = await import('fs/promises');
  async function walk(dir: string, rel: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) files.push(...(await walk(join(dir, e.name), rel + e.name + '/')));
      else if (e.name === 'route.ts' || e.name === 'route.tsx') files.push(`app/api/${rel}${e.name}`);
    }
    return files;
  }

  const routeFiles = await walk(join(projectPath, 'app', 'api'), '');

  for (const rel of routeFiles) {
    const absPath = join(projectPath, rel);
    try {
      const src = await readFile(absPath, 'utf-8');

      // Check: calls getAuthUser without await
      if (!/getAuthUser/.test(src)) continue;
      if (!/const\s+\w+\s*=\s*getAuthUser\s*\(/.test(src)) continue; // already awaited

      // Apply: add await before every `= getAuthUser(`
      const fixed = src.replace(
        /const\s+(\w+)\s*=\s*getAuthUser\s*\(/g,
        'const $1 = await getAuthUser(',
      );

      if (fixed === src) continue; // nothing changed

      // Also fix .userId → .sub (common companion mistake)
      const fixedSub = fixed.replace(
        /\b(auth(?:User)?|auth)\s*\.\s*userId\b/g,
        '$1.sub',
      );

      await writeFile(absPath, fixedSub, 'utf-8');
      fixes.push({
        transformId: 'auth-missing-await',
        file: rel,
        description: `Added missing \`await\` before getAuthUser() and corrected .userId → .sub`,
      });
    } catch { /* skip unreadable */ }
  }

  return fixes;
}

/**
 * DB-GET-RAW-INSTANCE
 * Pattern: "Property 'get' does not exist on type 'Database'"
 * Fix: rewrite lib/managed/db.ts with the canonical { all, get, run } wrapper
 */
async function fixDbRawInstance(projectPath: string): Promise<DeterministicFix[]> {
  const dbPath = join(projectPath, 'lib', 'managed', 'db.ts');
  try {
    const src = await readFile(dbPath, 'utf-8');
    // Check if it already has the wrapper pattern
    const hasWrapper = /export\s+const\s+db\s*=\s*\{[\s\S]*?\bget\s*[<(]/.test(src);
    if (hasWrapper) return [];

    await writeFile(dbPath, CANONICAL_DB_TS, 'utf-8');
    return [{
      transformId: 'db-get-raw-instance',
      file: 'lib/managed/db.ts',
      description: 'Replaced raw Database export with { all, get, run } wrapper so db.get() works correctly',
    }];
  } catch {
    // File missing — write it fresh
    const { mkdir } = await import('fs/promises');
    await mkdir(join(projectPath, 'lib', 'managed'), { recursive: true }).catch(() => {});
    await writeFile(dbPath, CANONICAL_DB_TS, 'utf-8');
    return [{
      transformId: 'db-get-raw-instance',
      file: 'lib/managed/db.ts',
      description: 'Created missing lib/managed/db.ts with { all, get, run } wrapper',
    }];
  }
}

/**
 * MISSING-USE-CLIENT
 * Pattern: hooks (useState/useEffect) used in a server component
 * Fix: prepend "use client"; to the component file
 */
async function fixMissingUseClient(projectPath: string, tsErrors: string[]): Promise<DeterministicFix[]> {
  const fixes: DeterministicFix[] = [];

  // Extract files from TS error lines like: app/page.tsx(10,5): error TS...
  const fileSet = new Set<string>();
  for (const err of tsErrors) {
    const m = /^((?:app|pages|components|src)\/[^\s(]+\.tsx?)\(\d+/.exec(err);
    if (m) fileSet.add(m[1]);
  }

  for (const rel of fileSet) {
    const absPath = join(projectPath, rel);
    try {
      const src = await readFile(absPath, 'utf-8');
      if (/^\s*['"]use client['"]/.test(src)) continue; // already there
      if (!/(useState|useEffect|useRef|useCallback|useMemo|useContext)\s*[<(]/.test(src)) continue;

      await writeFile(absPath, `"use client";\n\n${src}`, 'utf-8');
      fixes.push({
        transformId: 'missing-use-client',
        file: rel,
        description: `Prepended "use client" to component using React hooks`,
      });
    } catch { /* skip */ }
  }

  return fixes;
}

// ─── Route conflict resolution ───────────────────────────────────────────────

interface DuplicateRouteConflict {
  url: string;
  routeGroupFile: string;   // app/(group)/path/page.tsx
  bareFile: string;         // app/path/page.tsx
  groupHasLayout: boolean;
}

/**
 * Compute the resolved URL for a Next.js App Router page file.
 * Route group segments like `(auth)` are transparent — they don't appear in the URL.
 * Examples:
 *   app/page.tsx                      → /
 *   app/forgot-password/page.tsx      → /forgot-password
 *   app/(auth)/forgot-password/page.tsx → /forgot-password  ← same!
 */
function computePageUrl(relPath: string): string {
  const url = '/' + relPath
    .replace(/^app\//, '')
    .replace(/\([^)]+\)\//g, '')      // strip route group segments
    .replace(/\/page\.(tsx|ts|jsx|js)$/, '')
    .replace(/^page\.(tsx|ts|jsx|js)$/, '');
  return url || '/';
}

/** Walk `app/` for all page.tsx/page.ts/page.jsx/page.js files. */
async function findAllPageFiles(projectPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(e.name)) {
          results.push(relative(projectPath, full));
        }
      }
    } catch { /* skip unreadable */ }
  }
  await walk(join(projectPath, 'app'));
  return results;
}

/**
 * DUPLICATE-ROUTE-CONFLICT
 * Detects Next.js parallel page conflicts (route group vs bare path resolving to same URL).
 * Proactive: runs on file structure without needing build output.
 * Also triggered by error text: "two parallel pages that resolve to the same path".
 */
async function fixDuplicateRoutes(projectPath: string): Promise<DeterministicFix[]> {
  const fixes: DeterministicFix[] = [];
  const pages = await findAllPageFiles(projectPath);

  // Group pages by their resolved URL
  const urlMap = new Map<string, string[]>();
  for (const page of pages) {
    const url = computePageUrl(page);
    if (!urlMap.has(url)) urlMap.set(url, []);
    urlMap.get(url)!.push(page);
  }

  // Find conflicts: same URL claimed by ≥2 files
  for (const [url, files] of urlMap.entries()) {
    if (files.length < 2) continue;

    // Separate route-group files from bare files
    const routeGroupFiles = files.filter(f => /\([^)]+\)/.test(f));
    const bareFiles = files.filter(f => !/\([^)]+\)/.test(f));

    if (routeGroupFiles.length === 0 || bareFiles.length === 0) continue; // skip same-group conflicts

    // For each route-group file, check if its group has a layout
    for (const rgFile of routeGroupFiles) {
      const groupMatch = /app\/(\([^)]+\))\//.exec(rgFile);
      const groupDir = groupMatch ? join(projectPath, 'app', groupMatch[1]) : null;
      let groupHasLayout = false;
      if (groupDir) {
        for (const layoutName of ['layout.tsx', 'layout.ts', 'layout.jsx', 'layout.js']) {
          try { await stat(join(groupDir, layoutName)); groupHasLayout = true; break; } catch { /* not found */ }
        }
      }

      for (const bareFile of bareFiles) {
        // Decision: keep the route-group version if it has a layout; otherwise keep bare
        const fileToDelete = groupHasLayout ? bareFile : rgFile;
        const kept = groupHasLayout ? rgFile : bareFile;

        const absDelete = join(projectPath, fileToDelete);
        const parentDir = join(absDelete, '..');

        try {
          await rm(absDelete);

          // Remove the parent directory if it's now empty (only contained page.tsx)
          const remaining = await readdir(parentDir).catch(() => []);
          if (remaining.length === 0) {
            await rm(parentDir, { recursive: true }).catch(() => {});
          }

          fixes.push({
            transformId: 'duplicate-route-conflict',
            file: fileToDelete,
            description: `Removed duplicate route for ${url}: deleted ${fileToDelete} (kept ${kept})${groupHasLayout ? ' — route group has shared layout' : ' — route group has no layout, bare path preferred'}`,
          });
        } catch { /* skip if already deleted */ }
      }
    }
  }

  return fixes;
}

/**
 * Verify no duplicate routes remain (post-fix check, faster than next build).
 */
async function verifyNoDuplicateRoutes(projectPath: string): Promise<boolean> {
  const pages = await findAllPageFiles(projectPath);
  const urlMap = new Map<string, string[]>();
  for (const page of pages) {
    const url = computePageUrl(page);
    if (!urlMap.has(url)) urlMap.set(url, []);
    urlMap.get(url)!.push(page);
  }
  return ![...urlMap.values()].some(files => files.length > 1);
}

// ─── Pattern → Transform mapping ─────────────────────────────────────────────

const TRANSFORM_PATTERNS: Array<{
  pattern: RegExp;
  transformId: string;
  run: (projectPath: string, tsErrors: string[]) => Promise<DeterministicFix[]>;
}> = [
  {
    pattern: /does not exist on type.*Promise.*Token|Property.*sub.*Promise|Property.*userId.*Promise/i,
    transformId: 'auth-missing-await',
    run: (p) => fixAuthMissingAwait(p),
  },
  {
    pattern: /Property 'get' does not exist on type.*Database|Property 'all' does not exist on type.*Database/i,
    transformId: 'db-get-raw-instance',
    run: (p) => fixDbRawInstance(p),
  },
  {
    pattern: /useState.*not.*function|useEffect.*not.*function|You're importing a component that needs.*useState|hooks.*client component/i,
    transformId: 'missing-use-client',
    run: (p, e) => fixMissingUseClient(p, e),
  },
  {
    // Matches both the Next.js build error and the dev server error message
    pattern: /two parallel pages that resolve to the same path|cannot have two parallel pages|parallel pages.*same path/i,
    transformId: 'duplicate-route-conflict',
    run: (p) => fixDuplicateRoutes(p),
  },
];

// ─── TypeScript verification ──────────────────────────────────────────────────

async function runTsc(projectPath: string): Promise<{ errors: string[]; output: string }> {
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1', {
      cwd: projectPath,
      timeout: 60_000,
    });
    const out = (stdout + stderr).trim();
    const errors = out.split('\n').filter(l => /error TS\d+/.test(l));
    return { errors, output: out };
  } catch (e: unknown) {
    const out = (e instanceof Error && 'stdout' in e) ? String((e as { stdout?: string }).stdout ?? '') : '';
    const errors = out.split('\n').filter(l => /error TS\d+/.test(l));
    return { errors, output: out };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Attempt all deterministic transforms for the given error context.
 * Returns a summary of what was applied and whether TypeScript errors are gone.
 *
 * Call this BEFORE any AI model escalation. Only escalate to AI if this
 * returns `allFixed: false`.
 */
export async function runDeterministicRepairs(
  projectPath: string,
  errorText: string,
  tsErrors: string[],
): Promise<DeterministicRepairResult> {
  const combined = errorText + '\n' + tsErrors.join('\n');
  const applied: DeterministicFix[] = [];
  const skipped: string[] = [];

  // FORCE_TRANSFORM: engineering memory can inject a transform ID directly
  // so the repair runs that transform even if the error pattern doesn't match.
  const forceMatch = /\[FORCE_TRANSFORM:([a-z\-]+)\]/i.exec(combined);
  if (forceMatch) {
    const forceId = forceMatch[1];
    const forced = TRANSFORM_PATTERNS.find(t => t.transformId === forceId);
    if (forced) {
      try {
        const fixes = await forced.run(projectPath, tsErrors);
        if (fixes.length > 0) applied.push(...fixes);
        else skipped.push(`${forceId} (forced, no changes made)`);
      } catch (err) {
        skipped.push(`${forceId} (forced, failed: ${err instanceof Error ? err.message : err})`);
      }
    }
  }

  // ── Proactive route-conflict scan ────────────────────────────────────────────
  // Run regardless of error text: route conflicts produce ZERO TypeScript errors
  // but fail next build entirely. Check file structure directly, not error output.
  // Only do the scan if not already triggered by error pattern (avoid double-run).
  const routePatternTriggered = TRANSFORM_PATTERNS
    .find(t => t.transformId === 'duplicate-route-conflict')
    ?.pattern.test(combined) ?? false;

  if (!routePatternTriggered) {
    // Proactive check: scan for structural conflicts even if error text doesn't mention them
    try {
      const pages = await findAllPageFiles(projectPath);
      const urlMap = new Map<string, string[]>();
      for (const page of pages) {
        const url = computePageUrl(page);
        if (!urlMap.has(url)) urlMap.set(url, []);
        urlMap.get(url)!.push(page);
      }
      const hasConflicts = [...urlMap.values()].some(files => files.length > 1 &&
        files.some(f => /\([^)]+\)/.test(f)) &&
        files.some(f => !/\([^)]+\)/.test(f))
      );
      if (hasConflicts) {
        const routeFixes = await fixDuplicateRoutes(projectPath);
        if (routeFixes.length > 0) applied.push(...routeFixes);
        else skipped.push('duplicate-route-conflict (detected but nothing to delete)');
      }
    } catch { /* non-critical */ }
  }

  // Detect which error-triggered transforms are needed
  const triggered = TRANSFORM_PATTERNS.filter(t => t.pattern.test(combined));

  for (const t of triggered) {
    // Skip route-conflict if we already applied it proactively above
    if (t.transformId === 'duplicate-route-conflict' && applied.some(a => a.transformId === t.transformId)) {
      continue;
    }
    try {
      const fixes = await t.run(projectPath, tsErrors);
      if (fixes.length > 0) {
        applied.push(...fixes);
      } else {
        skipped.push(t.transformId);
      }
    } catch (err) {
      skipped.push(`${t.transformId} (failed: ${err instanceof Error ? err.message : err})`);
    }
  }

  if (applied.length === 0) {
    return { applied: [], skipped, remainingTsErrors: tsErrors, allFixed: false, tsOutput: '' };
  }

  // ── Verification ─────────────────────────────────────────────────────────────
  // If ONLY route conflicts were fixed: verify via file-structure scan (fast, no build).
  // If TypeScript transforms were also applied: run tsc --noEmit as usual.
  const onlyRouteFixes = applied.every(a => a.transformId === 'duplicate-route-conflict');

  if (onlyRouteFixes) {
    const noConflictsRemain = await verifyNoDuplicateRoutes(projectPath);
    return {
      applied,
      skipped,
      remainingTsErrors: [],
      allFixed: noConflictsRemain,
      tsOutput: noConflictsRemain
        ? 'Route conflicts resolved — no duplicate pages remain.'
        : 'Some route conflicts could not be resolved automatically.',
    };
  }

  // Re-run TypeScript to check whether the fixes resolved everything
  const { errors: remaining, output } = await runTsc(projectPath);
  const allFixed = remaining.length === 0;

  return { applied, skipped, remainingTsErrors: remaining, allFixed, tsOutput: output };
}
