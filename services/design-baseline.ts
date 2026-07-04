/**
 * Design Baseline — preserves the first-generation UI as the project's reference design.
 *
 * After the first successful generation, all UI files (pages, layouts, components, CSS)
 * are snapshotted to .design-baseline.json. During repair loops, any AI-generated
 * change to these files can be detected and rolled back so the original design is kept.
 *
 * Rules:
 * - Only app/**\/page.tsx, app/**\/layout.tsx, components/**, and *.css are UI files.
 * - Backend error kinds (route-failure, database-error, etc.) must never touch UI files.
 * - If a repair overwrites a UI file with ≥30% content change, restore from baseline.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join, relative, dirname } from 'path';

export const BASELINE_FILENAME = '.design-baseline.json';

// ── UI file patterns ──────────────────────────────────────────────────────────
// These are the files that form the visual identity of the generated app.
const UI_PATTERNS: RegExp[] = [
  /^app\/page\.tsx$/,
  /^app\/.*\/page\.tsx$/,
  /^app\/layout\.tsx$/,
  /^app\/.*\/layout\.tsx$/,
  /^app\/app\.css$/,
  /^app\/globals\.css$/,
  /^styles\//,
  /^components\//,
  /^app\/components\//,
  /\.module\.css$/,
];

export function isUIFile(relPath: string): boolean {
  return UI_PATTERNS.some(p => p.test(relPath));
}

// ── Backend error kinds — these must never cause UI file rewrites ─────────────
const BACKEND_KINDS = new Set([
  'route-failure',
  'wrong-http-method',
  'database-error',
  'provider-misconfigured',
  'timeout',
  'missing-route',
  'auth-error',
  'scaffold-placeholder',
  'build-error',
]);

export function isBackendErrorKind(kind: string): boolean {
  return BACKEND_KINDS.has(kind);
}

// ── Baseline I/O ──────────────────────────────────────────────────────────────

export interface BaselineEntry {
  path: string;
  content: string;
  savedAt: string;
}

/**
 * Walk the project tree and snapshot every UI file.
 * Writes .design-baseline.json at the project root.
 * Returns the list of relative paths saved.
 */
export async function saveDesignBaseline(projectPath: string): Promise<string[]> {
  const entries: BaselineEntry[] = [];
  const now = new Date().toISOString();

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules' || name === '.next') continue;
      const abs = join(dir, name);
      const rel = relative(projectPath, abs).replace(/\\/g, '/');
      let s;
      try { s = await stat(abs); } catch { continue; }
      if (s.isDirectory()) {
        await walk(abs);
      } else if (isUIFile(rel)) {
        try {
          const content = await readFile(abs, 'utf-8');
          entries.push({ path: rel, content, savedAt: now });
        } catch { /* skip unreadable */ }
      }
    }
  }

  await walk(projectPath);

  if (entries.length > 0) {
    await writeFile(
      join(projectPath, BASELINE_FILENAME),
      JSON.stringify(entries, null, 2),
      'utf-8',
    );
  }

  return entries.map(e => e.path);
}

/** Load the baseline; returns [] if none exists yet. */
export async function loadDesignBaseline(projectPath: string): Promise<BaselineEntry[]> {
  try {
    return JSON.parse(await readFile(join(projectPath, BASELINE_FILENAME), 'utf-8')) as BaselineEntry[];
  } catch {
    return [];
  }
}

/** True if a baseline exists for this project. */
export async function hasDesignBaseline(projectPath: string): Promise<boolean> {
  try {
    await stat(join(projectPath, BASELINE_FILENAME));
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore UI files from the baseline.
 * Only restores files that are in changedFiles AND are UI files AND exist in the baseline.
 * Returns the list of relative paths that were restored.
 */
export async function restoreBaselineFiles(
  projectPath: string,
  changedFiles: string[],
): Promise<string[]> {
  const baseline = await loadDesignBaseline(projectPath);
  if (baseline.length === 0) return [];

  const map = new Map<string, string>(baseline.map(e => [e.path, e.content]));
  const restored: string[] = [];

  for (const rel of changedFiles) {
    if (!isUIFile(rel)) continue;
    const original = map.get(rel);
    if (!original) continue;
    try {
      const abs = join(projectPath, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, original, 'utf-8');
      restored.push(rel);
    } catch { /* skip */ }
  }

  return restored;
}

/** Return the set of relative paths protected by the baseline. */
export async function getBaselineFileSet(projectPath: string): Promise<Set<string>> {
  const baseline = await loadDesignBaseline(projectPath);
  return new Set(baseline.map(e => e.path));
}

/**
 * Content drift check — returns true if the on-disk file has changed
 * significantly (>30% character difference) from the baseline version.
 * Used to detect when a repair has overwritten UI design inadvertently.
 */
export async function hasSignificantDrift(
  projectPath: string,
  relPath: string,
  baseline: BaselineEntry[],
): Promise<boolean> {
  const entry = baseline.find(e => e.path === relPath);
  if (!entry) return false;
  try {
    const current = await readFile(join(projectPath, relPath), 'utf-8');
    // Simple character-level change ratio
    const longer = Math.max(entry.content.length, current.length);
    if (longer === 0) return false;
    let same = 0;
    const shorter = Math.min(entry.content.length, current.length);
    for (let i = 0; i < shorter; i++) {
      if (entry.content[i] === current[i]) same++;
    }
    const similarity = same / longer;
    return similarity < 0.70; // less than 70% similar → significant drift
  } catch {
    return false;
  }
}
