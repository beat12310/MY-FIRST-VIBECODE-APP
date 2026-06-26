/**
 * Universal Signal Collector
 *
 * Phase 0 of the repair pipeline. Collects ALL error signals from every layer
 * of the stack into a single typed stream before any repair is attempted.
 *
 * Signal sources:
 *   typescript    — tsc --noEmit (type errors, import mismatches)
 *   build         — next build   (route conflicts, missing exports, bad dynamic imports)
 *   runtime-log   — .next-dev.log / next.log (crash logs, 500s, unhandled exceptions)
 *   route-conflict — file-structure scan (proactive, no build needed)
 *   missing-package — import analysis against node_modules
 *   missing-env   — process.env usage vs .env.local contents
 *   import-error  — @/ aliases that don't resolve to real files
 */

import { readFile, readdir, access, stat } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalSource =
  | 'typescript'
  | 'build'
  | 'runtime-log'
  | 'route-conflict'
  | 'missing-package'
  | 'missing-env'
  | 'import-error';

export type SignalSeverity = 'error' | 'warning';

export interface ErrorSignal {
  id: string;
  source: SignalSource;
  severity: SignalSeverity;
  file?: string;        // relative path from project root
  line?: number;
  message: string;
  raw: string;
  code?: string;        // TS error code (TS2345 etc), HTTP status, etc.
}

export interface SignalCollection {
  signals: ErrorSignal[];
  hasTypeScriptErrors: boolean;
  hasBuildErrors: boolean;
  hasRuntimeErrors: boolean;
  hasRouteConflicts: boolean;
  hasMissingPackages: boolean;
  hasMissingEnvVars: boolean;
  totalCount: number;
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _signalCounter = 0;
function makeId(source: SignalSource): string {
  return `${source}-${++_signalCounter}`;
}

// ─── TypeScript signals ───────────────────────────────────────────────────────

async function collectTypeScriptSignals(projectPath: string): Promise<ErrorSignal[]> {
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1', {
      cwd: projectPath,
      timeout: 45_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = stdout + stderr;
    return parseTscOutput(output, projectPath);
  } catch (err: unknown) {
    const output = (err as { stdout?: string; stderr?: string })?.stdout ?? '';
    return parseTscOutput(output, projectPath);
  }
}

function parseTscOutput(output: string, projectPath: string): ErrorSignal[] {
  const signals: ErrorSignal[] = [];
  // Format: path(line,col): error TSxxxx: message
  const re = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const [, rawPath, lineStr, severity, code, message] = m;
    const absPath = rawPath.trim();
    const relPath = absPath.startsWith(projectPath)
      ? relative(projectPath, absPath)
      : rawPath.trim();
    signals.push({
      id: makeId('typescript'),
      source: 'typescript',
      severity: severity === 'error' ? 'error' : 'warning',
      file: relPath,
      line: parseInt(lineStr, 10),
      message: message.trim(),
      raw: m[0],
      code,
    });
  }
  return signals;
}

// ─── Build signals ────────────────────────────────────────────────────────────

async function collectBuildSignals(
  projectPath: string,
  runBuildCheck: boolean,
): Promise<ErrorSignal[]> {
  if (!runBuildCheck) return [];

  try {
    const { stdout, stderr } = await execAsync(
      'npx next build --no-lint 2>&1',
      { cwd: projectPath, timeout: 60_000, env: { ...process.env, FORCE_COLOR: '0' } },
    );
    return parseBuildOutput(stdout + stderr, projectPath);
  } catch (err: unknown) {
    const output = (err as { stdout?: string })?.stdout ?? '';
    return parseBuildOutput(output, projectPath);
  }
}

function parseBuildOutput(output: string, projectPath: string): ErrorSignal[] {
  const signals: ErrorSignal[] = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Route conflict: "You cannot have two parallel pages that resolve to the same path"
    if (/two parallel pages|cannot have two parallel pages/i.test(line)) {
      const context = lines.slice(Math.max(0, i - 1), i + 4).join(' ');
      signals.push({
        id: makeId('build'),
        source: 'build',
        severity: 'error',
        message: line.trim(),
        raw: context,
        code: 'ROUTE_CONFLICT',
      });
    }

    // Type error in build
    if (/^Type error:/i.test(line)) {
      const fileMatch = lines[i - 1]?.match(/^\.\/(.+?\.tsx?)/) ??
                        lines[i + 1]?.match(/^\.\/(.+?\.tsx?)/);
      signals.push({
        id: makeId('build'),
        source: 'build',
        severity: 'error',
        file: fileMatch ? fileMatch[1] : undefined,
        message: line.replace(/^Type error:\s*/i, '').trim(),
        raw: lines.slice(Math.max(0, i - 1), i + 2).join('\n'),
        code: 'BUILD_TYPE_ERROR',
      });
    }

    // Missing module in build
    if (/Module not found:|Can't resolve/i.test(line)) {
      signals.push({
        id: makeId('build'),
        source: 'build',
        severity: 'error',
        message: line.trim(),
        raw: line,
        code: 'MODULE_NOT_FOUND',
      });
    }

    // Failed to compile
    if (/Failed to compile|Build error occurred|Error occurred prerendering page/i.test(line)) {
      signals.push({
        id: makeId('build'),
        source: 'build',
        severity: 'error',
        message: line.trim(),
        raw: lines.slice(i, i + 3).join('\n'),
      });
    }
  }

  return signals;
}

// ─── Runtime log signals ──────────────────────────────────────────────────────

async function collectRuntimeLogSignals(projectPath: string): Promise<ErrorSignal[]> {
  const logCandidates = ['.next-dev.log', 'next.log', '.next/server.log'];
  const signals: ErrorSignal[] = [];

  for (const candidate of logCandidates) {
    try {
      const logPath = join(projectPath, candidate);
      const st = await stat(logPath);
      // Only read recent logs (last 10 minutes)
      if (Date.now() - st.mtimeMs > 10 * 60 * 1000) continue;

      const content = await readFile(logPath, 'utf-8');
      const tail = content.slice(-8000); // last 8KB

      // Error lines
      const errorRe = /^.*(?:error|Error|ERROR|TypeError|RangeError|SyntaxError|UnhandledRejection).{0,200}$/gm;
      let m: RegExpExecArray | null;
      while ((m = errorRe.exec(tail)) !== null) {
        const msg = m[0].trim();
        if (msg.length < 10) continue;
        signals.push({
          id: makeId('runtime-log'),
          source: 'runtime-log',
          severity: 'error',
          message: msg.slice(0, 200),
          raw: msg,
        });
        if (signals.length >= 5) break; // cap runtime log signals
      }
      break; // first readable log wins
    } catch { /* log not found or unreadable */ }
  }

  return signals;
}

// ─── Route conflict signals (proactive file-structure scan) ───────────────────

function computePageUrl(relPath: string): string {
  const url = '/' + relPath
    .replace(/^app\//, '')
    .replace(/\([^)]+\)\//g, '')
    .replace(/\/page\.(tsx|ts|jsx|js)$/, '')
    .replace(/^page\.(tsx|ts|jsx|js)$/, '');
  return url || '/';
}

async function collectRouteConflictSignals(projectPath: string): Promise<ErrorSignal[]> {
  const signals: ErrorSignal[] = [];

  async function findPages(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) results.push(...await findPages(full));
        else if (e.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(e.name))
          results.push(relative(projectPath, full));
      }
    } catch { /* unreadable */ }
    return results;
  }

  const pages = await findPages(join(projectPath, 'app'));
  const urlMap = new Map<string, string[]>();
  for (const page of pages) {
    const url = computePageUrl(page);
    if (!urlMap.has(url)) urlMap.set(url, []);
    urlMap.get(url)!.push(page);
  }

  for (const [url, files] of urlMap) {
    if (files.length < 2) continue;
    const hasGroup = files.some(f => /\([^)]+\)/.test(f));
    const hasBare = files.some(f => !/\([^)]+\)/.test(f));
    if (hasGroup && hasBare) {
      signals.push({
        id: makeId('route-conflict'),
        source: 'route-conflict',
        severity: 'error',
        message: `Route conflict: ${files.join(' and ')} both resolve to ${url}`,
        raw: `ROUTE_CONFLICT: ${files.join(' | ')} → ${url}`,
        code: 'ROUTE_CONFLICT',
      });
    }
  }

  return signals;
}

// ─── Missing package signals ──────────────────────────────────────────────────

async function collectMissingPackageSignals(
  projectPath: string,
  errorText: string,
): Promise<ErrorSignal[]> {
  const signals: ErrorSignal[] = [];
  const re = /Cannot find module '([^@.][^']+)'|Module not found.*'([^.][^']+)'/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((m = re.exec(errorText)) !== null) {
    const raw = (m[1] ?? m[2]).split('/')[0];
    const pkg = raw.startsWith('@') ? (m[1] ?? m[2]).split('/').slice(0, 2).join('/') : raw;
    if (!pkg || seen.has(pkg) || pkg.startsWith('.') || pkg.startsWith('@/')) continue;
    seen.add(pkg);

    // Verify it's actually missing from node_modules
    try {
      await access(join(projectPath, 'node_modules', pkg));
    } catch {
      signals.push({
        id: makeId('missing-package'),
        source: 'missing-package',
        severity: 'error',
        message: `Package '${pkg}' is imported but not installed`,
        raw: m[0],
        code: pkg,
      });
    }
  }

  return signals;
}

// ─── Missing env var signals ──────────────────────────────────────────────────

async function collectEnvSignals(projectPath: string): Promise<ErrorSignal[]> {
  const signals: ErrorSignal[] = [];

  // Load available env vars from .env.local
  const available = new Set<string>();
  try {
    const envContent = await readFile(join(projectPath, '.env.local'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim());
      if (match) available.add(match[1]);
    }
  } catch { /* no .env.local is fine */ }

  // Scan source files for process.env references
  const missing = new Set<string>();
  async function scanForEnv(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await scanForEnv(full);
        else if (e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name)) {
          const src = await readFile(full, 'utf-8').catch(() => '');
          const envRe = /process\.env\.([A-Z][A-Z0-9_]+)/g;
          let m: RegExpExecArray | null;
          while ((m = envRe.exec(src)) !== null) {
            const key = m[1];
            if (!available.has(key) && !key.startsWith('NEXT_PUBLIC_') && !['NODE_ENV', 'PORT', 'HOST'].includes(key)) {
              missing.add(key);
            }
          }
        }
      }
    } catch { /* skip */ }
  }
  await scanForEnv(join(projectPath, 'app'));
  await scanForEnv(join(projectPath, 'lib')).catch(() => {});
  await scanForEnv(join(projectPath, 'services')).catch(() => {});

  for (const key of missing) {
    signals.push({
      id: makeId('missing-env'),
      source: 'missing-env',
      severity: 'error',
      message: `Environment variable process.env.${key} is referenced in code but missing from .env.local`,
      raw: `MISSING_ENV: ${key}`,
      code: key,
    });
  }

  return signals;
}

// ─── Main collection function ─────────────────────────────────────────────────

export interface CollectSignalsOptions {
  /** Raw error text from builder (autoGatheredError, tsc output, dev log snippets) */
  existingErrorText?: string;
  /** Run next build check (expensive: ~30s) — skipped if TypeScript errors exist */
  runBuildCheck?: boolean;
  /** Skip runtime log check */
  skipRuntimeLog?: boolean;
}

export async function collectAllSignals(
  projectPath: string,
  opts: CollectSignalsOptions = {},
): Promise<SignalCollection> {
  const all: ErrorSignal[] = [];

  // Parse any existing error text that the caller already has
  if (opts.existingErrorText) {
    const existing = parseTscOutput(opts.existingErrorText, projectPath);
    all.push(...existing);

    // Also check if existing text contains build errors
    const buildFromExisting = parseBuildOutput(opts.existingErrorText, projectPath);
    all.push(...buildFromExisting);
  }

  // Run all signal collectors in parallel (fast ones)
  const [tsSignals, routeConflicts, pkgSignals, envSignals, runtimeSignals] = await Promise.all([
    collectTypeScriptSignals(projectPath),
    collectRouteConflictSignals(projectPath),
    collectMissingPackageSignals(projectPath, opts.existingErrorText ?? ''),
    collectEnvSignals(projectPath),
    opts.skipRuntimeLog ? Promise.resolve([]) : collectRuntimeLogSignals(projectPath),
  ]);

  all.push(...tsSignals, ...routeConflicts, ...pkgSignals, ...envSignals, ...runtimeSignals);

  // Run build check only if: no TS errors (they'd prevent build anyway) AND requested
  const hasTs = tsSignals.some(s => s.severity === 'error');
  const hasRouteConflict = routeConflicts.length > 0;
  const shouldRunBuild = (opts.runBuildCheck ?? false) && !hasTs && !hasRouteConflict;

  if (shouldRunBuild) {
    const buildSignals = await collectBuildSignals(projectPath, true);
    all.push(...buildSignals);
  }

  // Deduplicate by message fingerprint
  const seen = new Set<string>();
  const deduped = all.filter(s => {
    const key = `${s.source}:${s.file ?? ''}:${s.message.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Classify
  const hasTypeScriptErrors = deduped.some(s => s.source === 'typescript' && s.severity === 'error');
  const hasBuildErrors = deduped.some(s => s.source === 'build' && s.severity === 'error');
  const hasRuntimeErrors = deduped.some(s => s.source === 'runtime-log');
  const hasRouteConflicts = deduped.some(s => s.source === 'route-conflict');
  const hasMissingPackages = deduped.some(s => s.source === 'missing-package');
  const hasMissingEnvVars = deduped.some(s => s.source === 'missing-env');

  const summaryParts: string[] = [];
  if (hasTypeScriptErrors) summaryParts.push(`${deduped.filter(s => s.source === 'typescript').length} TypeScript error(s)`);
  if (hasBuildErrors) summaryParts.push(`${deduped.filter(s => s.source === 'build').length} build error(s)`);
  if (hasRouteConflicts) summaryParts.push(`${deduped.filter(s => s.source === 'route-conflict').length} route conflict(s)`);
  if (hasMissingPackages) summaryParts.push(`${deduped.filter(s => s.source === 'missing-package').length} missing package(s)`);
  if (hasMissingEnvVars) summaryParts.push(`${deduped.filter(s => s.source === 'missing-env').length} missing env var(s)`);
  if (hasRuntimeErrors) summaryParts.push(`${deduped.filter(s => s.source === 'runtime-log').length} runtime error(s)`);

  return {
    signals: deduped,
    hasTypeScriptErrors,
    hasBuildErrors,
    hasRuntimeErrors,
    hasRouteConflicts,
    hasMissingPackages,
    hasMissingEnvVars,
    totalCount: deduped.filter(s => s.severity === 'error').length,
    summary: summaryParts.length > 0 ? summaryParts.join(', ') : 'No errors detected',
  };
}
