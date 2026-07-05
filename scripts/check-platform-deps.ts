/**
 * Platform-level dependency checker — the equivalent of
 * services/engine/verifier.ts's uninstalledImports check, applied to the
 * DWOMOH Vibe Code platform's OWN source code rather than a generated app's.
 *
 * Scans every .ts/.tsx file under the platform's own source directories for
 * a bare package import (not relative, not "@/...") that isn't listed in
 * package.json's dependencies/devDependencies and isn't a Node.js builtin.
 * This is exactly the failure class that broke a generated app this session
 * (lib/managed/db.ts importing '@prisma/client', a package that was never
 * installed) — this script protects the platform's own code from the same
 * mistake, e.g. a service file importing a package that got removed from
 * package.json, or was only ever installed on one developer's machine.
 *
 * MUST use the TypeScript compiler API (not a text/regex scan) to find real
 * import declarations: this platform's own source is a code-GENERATION
 * engine, so files like services/project-generator.ts and
 * services/auth-scaffolder.ts legitimately contain large string/template
 * literals holding OTHER programs' import statements as data (e.g. the
 * MANAGED_DB_TS constant's `import Database from 'better-sqlite3'`, meant
 * for a GENERATED app, not this platform). A naive regex scan cannot tell
 * "real import in this file" from "import statement inside a string this
 * file happens to contain" — confirmed by running exactly that first and
 * getting 56 false positives, entirely from template-string content in
 * generator/scaffolder files. Parsing the AST and only inspecting actual
 * ImportDeclaration/CallExpression(require) nodes sidesteps the whole
 * problem: text inside a string or template literal is never treated as
 * code by the parser, so it's structurally impossible for it to be
 * misread as a real import.
 *
 * Run: npx tsx scripts/check-platform-deps.ts
 * Exits non-zero (and is wired into `npm run verify`) if any import is found
 * that isn't satisfied by an installed dependency, a Node builtin, or a
 * project-local path.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const ROOT = process.cwd();
const SOURCE_DIRS = ['app', 'components', 'services', 'lib', 'worker'];
const SKIP_DIRS = new Set(['node_modules', 'generated-projects', '.next', 'cdk.out', '__tests__']);
const NODE_BUILTINS = new Set([
  'path', 'fs', 'crypto', 'util', 'stream', 'events', 'os', 'url', 'http', 'https',
  'net', 'buffer', 'child_process', 'assert', 'querystring', 'zlib', 'readline',
  'timers', 'tty', 'dns', 'dgram', 'cluster', 'worker_threads', 'perf_hooks',
  'fs/promises', 'stream/promises', 'timers/promises', 'node:fs', 'node:path',
  'node:crypto', 'node:util', 'node:stream', 'node:events', 'node:os', 'node:url',
  'node:http', 'node:https', 'node:net', 'node:buffer', 'node:child_process',
  'node:assert', 'node:querystring', 'node:zlib', 'node:readline', 'node:timers',
  'node:tty', 'node:dns', 'node:fs/promises',
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

function loadInstalledDeps(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

export function extractBarePackageImports(filePath: string, content: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];

  function visit(node: ts.Node) {
    let spec: string | undefined;
    // import ... from 'x'; export ... from 'x';
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
    }
    // await import('x') / require('x') — real CALL EXPRESSIONS in the AST,
    // never matched inside a string/template literal since those are a
    // different node kind entirely.
    if (ts.isCallExpression(node)) {
      const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isImportCall || isRequireCall) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        spec = node.arguments[0].text;
      }
    }
    if (spec && !spec.startsWith('@/') && !spec.startsWith('.')) found.push(spec);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

export function packageNameOf(spec: string): string {
  return spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
}

// ─── Static-import-of-excluded-package check ─────────────────────────────────
// Root cause of a real production outage: app/api/chat/route.ts had a
// top-level `import { ... } from '@/services/browser-automation'`, and that
// module itself has a top-level `import { chromium } from 'playwright'`.
// next.config.js's outputFileTracingExcludes deliberately excludes
// node_modules/playwright/**, puppeteer/**, and sharp/** from the production
// bundle (to stay under Amplify's 230MB limit) -- so the moment ANY request
// hit /api/chat, loading the route module tried to load playwright, which
// wasn't in the deployed bundle, throwing ERR_MODULE_NOT_FOUND and crashing
// EVERY action, not just the ones that actually use a browser. The three
// other playwright-backed modules in this codebase were already correctly
// loaded via `await import(...)` inside their specific action handlers --
// which only evaluates, and only fails, when that action actually runs.
//
// This check finds any STATIC (top-level, always-evaluated) import chain,
// through this platform's own @/-prefixed modules only, that reaches a
// bare-package import of something listed in next.config.js's
// outputFileTracingExcludes. A DYNAMIC `await import(...)` is exempt, since
// it's lazy by construction -- that's the actual fix pattern this check enforces.

/** Static-only (ImportDeclaration/ExportDeclaration) specs -- excludes await import()/require() calls. */
export function extractStaticImportSpecs(filePath: string, content: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function loadExcludedPackages(): Set<string> {
  const configPath = join(ROOT, 'next.config.js');
  let content: string;
  try { content = readFileSync(configPath, 'utf8'); } catch { return new Set(); }
  const matches = [...content.matchAll(/['"]node_modules\/([^/'"]+)\/?\*\*['"]/g)];
  return new Set(matches.map(m => m[1]));
}

/** Resolves a "@/..." local module spec to an absolute file path on disk, if it exists. */
function resolveLocalSpec(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = join(ROOT, spec.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { statSync(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

export function checkStaticImportsOfExcludedPackages(): { file: string; pkg: string; chain: string[] }[] {
  const excluded = loadExcludedPackages();
  if (excluded.size === 0) return [];
  const files = SOURCE_DIRS.flatMap(d => walk(join(ROOT, d)));
  const issues: { file: string; pkg: string; chain: string[] }[] = [];

  const staticSpecsCache = new Map<string, string[]>();
  const getStaticSpecs = (file: string): string[] => {
    const cached = staticSpecsCache.get(file);
    if (cached) return cached;
    let specs: string[] = [];
    try { specs = extractStaticImportSpecs(file, readFileSync(file, 'utf8')); } catch { /* unreadable — skip */ }
    staticSpecsCache.set(file, specs);
    return specs;
  };

  // BFS through STATIC-only local (@/) import edges from `startFile`, looking
  // for any bare-package spec that's in the excluded set. Returns the chain
  // of file paths from startFile to the file with the offending import, or
  // null if no excluded package is reachable this way.
  const findExcludedChain = (startFile: string): { pkg: string; chain: string[] } | null => {
    const seen = new Set<string>([startFile]);
    const queue: { file: string; chain: string[] }[] = [{ file: startFile, chain: [startFile] }];
    while (queue.length > 0) {
      const { file, chain } = queue.shift()!;
      for (const spec of getStaticSpecs(file)) {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) {
          const pkg = packageNameOf(spec);
          if (excluded.has(pkg)) return { pkg, chain };
          continue;
        }
        const resolved = resolveLocalSpec(spec);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          queue.push({ file: resolved, chain: [...chain, resolved] });
        }
      }
    }
    return null;
  };

  // Only start the search from actual Next.js bundling entry points --
  // route.ts (API routes), page.tsx, layout.tsx, middleware.ts. A module
  // like services/browser-automation.ts is SUPPOSED to statically import
  // playwright (that's its whole purpose); the bug this check exists to
  // catch is only real when a route/entry point reaches it via a chain of
  // STATIC imports, since Next.js bundles everything reachable that way
  // into that route's Lambda regardless of whether the excluded package is
  // actually invoked at runtime.
  const entryPoints = files.filter(f => /[\\/](route|page|layout|middleware)\.tsx?$/.test(f));
  for (const file of entryPoints) {
    const result = findExcludedChain(file);
    if (result) issues.push({ file: relative(ROOT, file), pkg: result.pkg, chain: result.chain.map(f => relative(ROOT, f)) });
  }
  return issues;
}

export function checkPlatformDeps(): { file: string; pkg: string }[] {
  const installedDeps = loadInstalledDeps();
  const files = SOURCE_DIRS.flatMap(d => walk(join(ROOT, d)));
  const issues: { file: string; pkg: string }[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const spec of extractBarePackageImports(file, content)) {
      const pkg = packageNameOf(spec);
      if (!NODE_BUILTINS.has(pkg) && !installedDeps.has(pkg)) {
        issues.push({ file: relative(ROOT, file), pkg });
      }
    }
  }
  return issues;
}

if (require.main === module) {
  const issues = checkPlatformDeps();
  const excludedImportIssues = checkStaticImportsOfExcludedPackages();

  if (issues.length === 0 && excludedImportIssues.length === 0) {
    console.log('✓ check-platform-deps: every import resolves to an installed dependency, a Node builtin, or a project-local path.');
    console.log('✓ check-platform-deps: no static import chain reaches an outputFileTracingExcludes-excluded package.');
    process.exit(0);
  }

  if (issues.length > 0) {
    console.error(`✗ check-platform-deps: ${issues.length} import(s) reference a package not in package.json:\n`);
    for (const { file, pkg } of issues) console.error(`  ${file} imports "${pkg}"`);
  }
  if (excludedImportIssues.length > 0) {
    console.error(`\n✗ check-platform-deps: ${excludedImportIssues.length} STATIC import chain(s) reach a package excluded from the production bundle:\n`);
    for (const { file, pkg, chain } of excludedImportIssues) {
      console.error(`  ${file} statically loads "${pkg}" via: ${chain.join(' -> ')}`);
      console.error(`    Fix: use "await import(...)" inside the specific code path that needs it, not a top-level import.`);
    }
  }
  process.exit(1);
}
