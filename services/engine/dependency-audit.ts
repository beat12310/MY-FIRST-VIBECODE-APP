/**
 * Dependency-generation audit — ensures every shared type/helper/util/model/
 * constant/lib file the generated code imports actually exists, BEFORE
 * verification runs. Without this, a missing shared import survives as a
 * "Broken import" failure that the generic repair path handles poorly (the
 * failure detail carries an import SPECIFIER like "@/lib/types/property", not
 * a file path ending in .ts/.tsx, so the repairer's path-extraction regex
 * can't find a target and the fix stalls — this is exactly what happened to
 * the Property Listing App in live testing).
 *
 * Detection mirrors verifier.ts's resolveImport() extension-candidate order
 * exactly, so this audit and the verifier never disagree about what counts
 * as "missing".
 */

export interface MissingSharedFile {
  /** Best-guess file path to create, e.g. "lib/types/property.ts". */
  resolvedPath: string;
  /** The raw import specifier, e.g. "@/lib/types/property". */
  spec: string;
  /** Files that import this spec, with the exact import statement for context. */
  importedBy: { file: string; statement: string }[];
}

// Same extension-candidate order as verifier.ts's resolveImport, so detection
// here and there never disagree about what counts as "missing".
const EXT_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

// Never treat the platform-injected managed-service files as "missing" —
// they're always written by injectManagedServices regardless of what the AI output.
const SKIP_PREFIXES = ['lib/managed/'];

function resolveBase(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = fromFile.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') dir.pop(); else dir.push(part);
    }
    return dir.join('/');
  }
  return null; // external package — not our concern
}

/** Preferred single path to create for a resolved base (used for generation). */
function preferredPath(base: string): string {
  const isComponentLike = /(?:^|\/)[A-Z]/.test(base.split('/').pop() ?? '') || base.startsWith('components/');
  return isComponentLike ? `${base}.tsx` : `${base}.ts`;
}

const IMPORT_RE = /import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;

export function findMissingSharedImports(files: { path: string; content: string }[]): MissingSharedFile[] {
  const fileSet = new Set(files.map(f => f.path));
  const codeFiles = files.filter(f => /\.(tsx?|jsx?)$/.test(f.path));
  const byResolvedPath = new Map<string, MissingSharedFile>();

  for (const file of codeFiles) {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(file.content))) {
      const spec = m[1];
      const base = resolveBase(spec, file.path);
      if (!base) continue; // external package
      if (SKIP_PREFIXES.some(p => base.startsWith(p))) continue;
      if (EXT_CANDIDATES.some(e => fileSet.has(base + e))) continue; // already exists

      const resolvedPath = preferredPath(base);
      const entry = byResolvedPath.get(resolvedPath);
      const importedBy = { file: file.path, statement: m[0] };
      if (entry) {
        if (!entry.importedBy.some(i => i.file === file.path)) entry.importedBy.push(importedBy);
      } else {
        byResolvedPath.set(resolvedPath, { resolvedPath, spec, importedBy: [importedBy] });
      }
    }
  }
  return [...byResolvedPath.values()];
}
