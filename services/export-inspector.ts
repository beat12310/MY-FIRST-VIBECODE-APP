/**
 * Export Inspector
 *
 * Reads a TypeScript/JavaScript source file and extracts every symbol it
 * exports WITHOUT running the compiler. Used before every surgical edit so
 * the AI prompt includes the REAL export map instead of hallucinated names.
 *
 * Examples of what it catches:
 *   getDb   (hallucinated) → db, initTable, generateId  (actual exports)
 *   getCurrentUser (hallucinated) → getAuthUser, registerUser  (actual)
 */

import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportMap {
  /** Named exports: functions, consts, classes, enums */
  named: string[];
  /** Default export name (or 'default' if anonymous) */
  default: string | null;
  /** Type-only exports: interfaces, type aliases */
  types: string[];
}

export interface ImportExportMap {
  /** Original import specifier, e.g. '@/lib/managed/db' */
  specifier: string;
  /** Resolved file path (if found) */
  resolvedPath: string | null;
  /** What that file actually exports */
  exports: ExportMap;
}

// ─── Single-file export extractor ────────────────────────────────────────────

export function extractExports(source: string): ExportMap {
  const named: string[] = [];
  const types: string[] = [];
  let defaultExport: string | null = null;

  // export async function Foo / export function Foo / export class Foo / export enum Foo
  const namedFnRe = /^export\s+(?:async\s+)?(?:function|class|enum|abstract\s+class)\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = namedFnRe.exec(source)) !== null) named.push(m[1]);

  // export const/let/var Foo = ...
  const namedVarRe = /^export\s+(?:const|let|var)\s+(\w+)/gm;
  while ((m = namedVarRe.exec(source)) !== null) named.push(m[1]);

  // export { Foo, Bar, Baz }  or  export { Foo as Bar }
  const namedGroupRe = /^export\s*\{([^}]+)\}/gm;
  while ((m = namedGroupRe.exec(source)) !== null) {
    const entries = m[1].split(',').map(e => e.trim()).filter(Boolean);
    for (const entry of entries) {
      // handle "X as Y" — the exported name is Y
      const asParts = entry.split(/\s+as\s+/);
      const exportedName = (asParts[1] ?? asParts[0]).trim();
      if (exportedName && !exportedName.includes('*') && !exportedName.startsWith('type ')) {
        named.push(exportedName);
      }
    }
  }

  // export type Foo / export interface Foo
  const typeRe = /^export\s+(?:type|interface)\s+(\w+)/gm;
  while ((m = typeRe.exec(source)) !== null) types.push(m[1]);

  // export type { Foo, Bar }
  const typeGroupRe = /^export\s+type\s*\{([^}]+)\}/gm;
  while ((m = typeGroupRe.exec(source)) !== null) {
    const entries = m[1].split(',').map(e => e.trim()).filter(Boolean);
    for (const entry of entries) {
      const asParts = entry.split(/\s+as\s+/);
      const exportedName = (asParts[1] ?? asParts[0]).trim();
      if (exportedName) types.push(exportedName);
    }
  }

  // export default function Foo / export default class Foo
  const defNamedRe = /^export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm;
  m = defNamedRe.exec(source);
  if (m) {
    defaultExport = m[1];
  } else {
    // export default Foo (identifier)
    const defIdRe = /^export\s+default\s+(\w+)/gm;
    m = defIdRe.exec(source);
    if (m) defaultExport = m[1];
    else if (/^export\s+default\s+/m.test(source)) defaultExport = 'default';
  }

  return {
    named: [...new Set(named)],
    default: defaultExport,
    types: [...new Set(types)],
  };
}

// ─── Import specifier extractor ───────────────────────────────────────────────
// Finds all import statements in a file and extracts the specifiers.

export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // import X from '...' / import { X } from '...' / import '...'
  const importRe = /^import\s[^'"]*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    specifiers.push(m[1]);
  }
  return [...new Set(specifiers)];
}

// ─── Specifier resolver ───────────────────────────────────────────────────────
// Maps @/lib/managed/db → /project/lib/managed/db.ts (tries common extensions)

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

async function resolveSpecifier(spec: string, projectPath: string): Promise<string | null> {
  // Only handle local imports (@ alias or relative)
  if (!spec.startsWith('@/') && !spec.startsWith('./') && !spec.startsWith('../')) return null;

  const rel = spec.startsWith('@/') ? spec.slice(2) : spec;
  const base = join(projectPath, rel);

  // Exact path
  for (const ext of ['', ...RESOLVE_EXTS]) {
    try {
      await readFile(base + ext, 'utf-8');
      return base + ext;
    } catch {}
  }

  // index file
  for (const ext of RESOLVE_EXTS) {
    try {
      await readFile(join(base, `index${ext}`), 'utf-8');
      return join(base, `index${ext}`);
    } catch {}
  }

  return null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * For a given source file, extract the real exports of every @/lib or @/components
 * import it uses. Returns a map so the caller can inject it into the AI prompt.
 */
export async function inspectImportedExports(
  sourceFilePath: string,
  projectPath: string,
): Promise<ImportExportMap[]> {
  let source: string;
  try {
    source = await readFile(sourceFilePath, 'utf-8');
  } catch {
    return [];
  }

  const specifiers = extractImportSpecifiers(source).filter(
    s => s.startsWith('@/') || s.startsWith('./') || s.startsWith('../'),
  );

  const results: ImportExportMap[] = [];

  for (const spec of specifiers) {
    const resolvedPath = await resolveSpecifier(spec, projectPath);
    if (!resolvedPath) {
      results.push({ specifier: spec, resolvedPath: null, exports: { named: [], default: null, types: [] } });
      continue;
    }
    try {
      const depSource = await readFile(resolvedPath, 'utf-8');
      results.push({ specifier: spec, resolvedPath, exports: extractExports(depSource) });
    } catch {
      results.push({ specifier: spec, resolvedPath, exports: { named: [], default: null, types: [] } });
    }
  }

  return results;
}

/**
 * Format the import export map as a concise block for injection into a prompt.
 * E.g.:
 *   @/lib/managed/db  →  exports: db (object), initTable, generateId
 *   @/lib/managed/auth  →  exports: getAuthUser, registerUser, AuthUser (type)
 */
export function formatExportMap(maps: ImportExportMap[]): string {
  if (maps.length === 0) return '(no local imports found)';

  return maps.map(m => {
    const parts: string[] = [];
    if (m.exports.default) parts.push(`default: ${m.exports.default}`);
    if (m.exports.named.length) parts.push(`named: ${m.exports.named.join(', ')}`);
    if (m.exports.types.length) parts.push(`types: ${m.exports.types.join(', ')}`);
    const summary = parts.length ? parts.join(' | ') : '(no exports found)';
    return `  ${m.specifier}  →  ${summary}`;
  }).join('\n');
}

// ─── Project-wide export scanner ─────────────────────────────────────────────
// Used for debugging: scans the entire lib/ directory and returns a full map.

export async function scanProjectExports(
  projectPath: string,
): Promise<Record<string, ExportMap>> {
  const result: Record<string, ExportMap> = {};

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.next', '.git'].includes(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && ['.ts', '.tsx'].includes(extname(e.name))) {
        try {
          const src = await readFile(abs, 'utf-8');
          const exps = extractExports(src);
          if (exps.named.length || exps.default || exps.types.length) {
            const rel = abs.replace(projectPath + '/', '');
            result[rel] = exps;
          }
        } catch {}
      }
    }
  }

  await walk(join(projectPath, 'lib'));
  await walk(join(projectPath, 'components'));
  return result;
}
