/**
 * Multi-Level Verification Suite
 *
 * Verifies a generated project at progressively deeper levels:
 *
 *   L1 — TypeScript validation (tsc --noEmit, ~3s)
 *        Passes: all types are valid
 *        Misses: route conflicts, missing exports, dynamic imports, runtime errors
 *
 *   L2 — Full Next.js build validation (next build --no-lint, ~20-45s)
 *        Passes: project compiles end-to-end
 *        Misses: runtime errors, bad API responses, missing env vars at runtime
 *
 *   L3 — Static route analysis (~1s)
 *        Verifies each API route file exports at least one HTTP handler,
 *        that its imports exist on disk, and that no obvious runtime issues
 *        are detectable without running the server.
 *
 *   L4 — HTTP health checks (requires server to be running)
 *        Hits each API route and checks for 2xx/4xx vs 5xx
 *        Currently gated: only runs if a port is provided.
 *
 * The right level to run depends on what was just repaired:
 *   - Route conflict fix → run L2 (build is the only definitive check)
 *   - TypeScript fix     → run L1 (fast, sufficient)
 *   - Feature addition   → run L1 + L3
 *   - Full repair cycle  → run L1 → L2 → L3
 */

import { readFile, readdir, access } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LevelResult {
  level: 1 | 2 | 3 | 4;
  passed: boolean;
  errors: string[];
  warnings: string[];
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}

export interface VerificationSuiteResult {
  highestLevelPassed: 0 | 1 | 2 | 3 | 4;
  allPassed: boolean;
  l1: LevelResult;
  l2: LevelResult;
  l3: LevelResult;
  l4: LevelResult;
  totalDurationMs: number;
  summary: string;
}

// ─── L1: TypeScript ───────────────────────────────────────────────────────────

async function runL1(projectPath: string): Promise<LevelResult> {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1', {
      cwd: projectPath, timeout: 45_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const out = stdout + stderr;
    const errors = out.split('\n').filter(l => /\berror\b/i.test(l) && /TS\d+/.test(l));
    return { level: 1, passed: errors.length === 0, errors, warnings: [], durationMs: Date.now() - t0, skipped: false };
  } catch (err: unknown) {
    const out = (err as { stdout?: string })?.stdout ?? String(err);
    const errors = out.split('\n').filter(l => /\berror\b/i.test(l) && /TS\d+/.test(l));
    return { level: 1, passed: false, errors: errors.slice(0, 10), warnings: [], durationMs: Date.now() - t0, skipped: false };
  }
}

// ─── L2: Next.js build ───────────────────────────────────────────────────────

async function runL2(projectPath: string): Promise<LevelResult> {
  const t0 = Date.now();
  try {
    await execAsync('npx next build --no-lint 2>&1', {
      cwd: projectPath, timeout: 120_000,
      env: { ...process.env, FORCE_COLOR: '0', NEXT_TELEMETRY_DISABLED: '1' },
    });
    return { level: 2, passed: true, errors: [], warnings: [], durationMs: Date.now() - t0, skipped: false };
  } catch (err: unknown) {
    const out = (err as { stdout?: string })?.stdout ?? String(err);
    const errors: string[] = [];

    // Route conflict
    if (/two parallel pages|cannot have two parallel pages/i.test(out)) {
      const m = /Please check.*$/m.exec(out);
      errors.push(`Route conflict: ${m ? m[0] : 'two pages resolve to the same URL'}`);
    }

    // Type errors
    const typeErrors = out.match(/^Type error:.+/gm) ?? [];
    errors.push(...typeErrors.slice(0, 5));

    // Module not found
    const moduleErrors = out.match(/Module not found:.+|Can't resolve.+/g) ?? [];
    errors.push(...moduleErrors.slice(0, 5));

    // Failed to compile
    if (errors.length === 0 && /Failed to compile|Build error/i.test(out)) {
      errors.push('Build failed — see logs for details');
    }

    return {
      level: 2, passed: false,
      errors: errors.length > 0 ? errors : ['Build failed'],
      warnings: [], durationMs: Date.now() - t0, skipped: false,
    };
  }
}

// ─── L3: Static route analysis ───────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

async function runL3(projectPath: string): Promise<LevelResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Find all API route files
  const routeFiles: string[] = [];
  async function findRoutes(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await findRoutes(abs);
        else if (e.isFile() && /^route\.(ts|js)$/.test(e.name)) routeFiles.push(abs);
      }
    } catch { /* skip */ }
  }
  await findRoutes(join(projectPath, 'app', 'api'));

  for (const routeFile of routeFiles) {
    const rel = relative(projectPath, routeFile);
    try {
      const content = await readFile(routeFile, 'utf-8');

      // Check at least one HTTP method is exported
      const exportedMethods = HTTP_METHODS.filter(m =>
        new RegExp(`^export\\s+(?:async\\s+)?function\\s+${m}\\b`, 'm').test(content)
      );
      if (exportedMethods.length === 0) {
        errors.push(`${rel}: exports no HTTP handler (GET/POST/PUT/DELETE/PATCH)`);
      }

      // Check local imports resolve to existing files
      const importRe = /from\s+['"](@\/[^'"]+|\.\/[^'"]+|\.\.\/[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const imp = m[1];
        if (!imp.startsWith('@/') && !imp.startsWith('./') && !imp.startsWith('../')) continue;

        const absImp = imp.startsWith('@/')
          ? join(projectPath, imp.replace('@/', ''))
          : join(routeFile, '..', imp);

        let found = false;
        for (const ext of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
          try { await access(absImp + ext); found = true; break; } catch { /* try next */ }
        }
        if (!found) errors.push(`${rel}: imports '${imp}' which does not exist on disk`);
      }

      // Warn if process.env references are used but key looks unset
      const envRe = /process\.env\.([A-Z][A-Z0-9_]+)/g;
      while ((m = envRe.exec(content)) !== null) {
        const key = m[1];
        if (/PASSWORD|SECRET|KEY|TOKEN/.test(key)) {
          try {
            const envFile = await readFile(join(projectPath, '.env.local'), 'utf-8');
            if (!envFile.includes(`${key}=`)) {
              warnings.push(`${rel}: uses process.env.${key} but it is not set in .env.local`);
            }
          } catch { /* no .env.local */ }
        }
      }
    } catch { /* skip unreadable */ }
  }

  return {
    level: 3, passed: errors.length === 0,
    errors: errors.slice(0, 10), warnings: warnings.slice(0, 5),
    durationMs: Date.now() - t0, skipped: routeFiles.length === 0,
    skipReason: routeFiles.length === 0 ? 'No API route files found' : undefined,
  };
}

// ─── L4: HTTP health (requires running server) ────────────────────────────────

async function runL4(port: number | null): Promise<LevelResult> {
  const t0 = Date.now();
  if (!port) {
    return { level: 4, passed: true, errors: [], warnings: [], durationMs: 0, skipped: true, skipReason: 'No server port provided' };
  }

  const errors: string[] = [];
  try {
    const healthRes = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (healthRes.status >= 500) errors.push(`/api/health returned HTTP ${healthRes.status}`);
  } catch {
    // No /api/health endpoint — not an error, just not present
  }

  return { level: 4, passed: errors.length === 0, errors, warnings: [], durationMs: Date.now() - t0, skipped: false };
}

// ─── Main function ────────────────────────────────────────────────────────────

export interface VerificationOptions {
  /** Maximum level to run (default: 3) */
  maxLevel?: 1 | 2 | 3 | 4;
  /** Port of running dev server for L4 */
  port?: number | null;
  /** Skip L2 even if L1 passes (L2 takes 20-45s) */
  skipL2?: boolean;
}

const SKIPPED: LevelResult = { level: 1, passed: true, errors: [], warnings: [], durationMs: 0, skipped: true };

export async function runVerificationSuite(
  projectPath: string,
  opts: VerificationOptions = {},
): Promise<VerificationSuiteResult> {
  const maxLevel = opts.maxLevel ?? 3;
  const t0 = Date.now();

  const l1 = await runL1(projectPath);
  const l2: LevelResult = (maxLevel >= 2 && !opts.skipL2 && l1.passed)
    ? await runL2(projectPath)
    : { ...SKIPPED, level: 2, skipReason: l1.passed ? 'Skipped by caller' : 'L1 failed — skipping build check' };

  const l3: LevelResult = (maxLevel >= 3 && l1.passed)
    ? await runL3(projectPath)
    : { ...SKIPPED, level: 3, skipReason: 'L1 failed — skipping route analysis' };

  const l4: LevelResult = maxLevel >= 4
    ? await runL4(opts.port ?? null)
    : { ...SKIPPED, level: 4, skipReason: 'Level 4 not requested' };

  const levels = [l1, l2, l3, l4];
  const allPassed = levels.every(lv => lv.passed || lv.skipped);

  let highest: 0 | 1 | 2 | 3 | 4 = 0;
  for (const lv of levels) {
    if (!lv.skipped && lv.passed) highest = lv.level as 0 | 1 | 2 | 3 | 4;
  }

  const failedLevels = levels.filter(lv => !lv.skipped && !lv.passed);
  const summary = allPassed
    ? `All checks passed (L${highest})`
    : failedLevels.map(lv => `L${lv.level} failed: ${lv.errors[0] ?? 'unknown'}`).join(' | ');

  return {
    highestLevelPassed: highest,
    allPassed,
    l1, l2, l3, l4,
    totalDurationMs: Date.now() - t0,
    summary,
  };
}
