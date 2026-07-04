/**
 * Build verification report. Scans a generated project ON DISK and returns the
 * concrete facts of what was actually created — pages, routes, components, and any
 * referenced-but-missing routes (dead links / would-be 404s). Deterministic, no
 * running server required. Used to prove a build produced REAL files, not a spec.
 */
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';

export interface BuildReport {
  projectPath: string;
  fileCount: number;
  pages: string[];        // URL routes that have a page file
  apiRoutes: string[];    // /api/* route handlers
  components: number;
  referencedRoutes: number;
  deadLinks: string[];    // links pointing to routes with no page → 404 risk
  ok: boolean;            // true when a root page exists and there are no dead links
}

const SKIP = new Set(['node_modules', '.next', '.git', '.dwomoh']);

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return acc; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let s; try { s = await stat(p); } catch { continue; }
    if (s.isDirectory()) await walk(p, acc); else acc.push(p);
  }
  return acc;
}

function fileToRoute(rel: string): string | null {
  if (/^(?:src\/)?app\/page\.[jt]sx?$/.test(rel)) return '/';
  const m = rel.match(/^(?:src\/)?app\/(.*?)\/page\.[jt]sx?$/);
  if (!m) return null;
  const seg = m[1].replace(/\([^)]+\)\//g, '').replace(/\([^)]+\)$/, '').replace(/\/+$/, '');
  return seg ? '/' + seg : '/';
}
const canon = (r: string) => r.replace(/\[[^\]]+\]/g, '[x]').replace(/\/+$/, '') || '/';

const REF_PATTERNS = [
  /href\s*=\s*["'`](\/[^"'`?#${[]*)/g,
  /href\s*=\s*\{\s*["'`](\/[^"'`?#${[]*)/g,
  /router\.push\(\s*["'`](\/[^"'`?#${[]*)/g,
  /href:\s*["'`](\/[^"'`?#${[]*)/g,
];

export async function buildReport(projectPath: string): Promise<BuildReport> {
  const files = (await walk(projectPath)).map(f => f.replace(projectPath + '/', ''));
  const code = files.filter(f => /\.(tsx?|jsx?)$/.test(f));

  const pages: string[] = [];
  const pageSet = new Set<string>();
  const apiRoutes: string[] = [];
  let components = 0;

  for (const rel of files) {
    const r = fileToRoute(rel);
    if (r) { pages.push(r); pageSet.add(canon(r)); }
    if (/^(?:src\/)?app\/api\/.*route\.[jt]sx?$/.test(rel)) apiRoutes.push('/' + rel.replace(/^(?:src\/)?app\//, '').replace(/\/route\.[jt]sx?$/, ''));
    if (/^(?:src\/)?components\//.test(rel)) components++;
  }

  const referenced = new Set<string>();
  for (const rel of code) {
    let content = '';
    try { content = await readFile(join(projectPath, rel), 'utf-8'); } catch { continue; }
    for (const re of REF_PATTERNS) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const route = (m[1].replace(/\/+$/, '') || '/');
        if (route.startsWith('/api')) continue;
        referenced.add(route);
      }
    }
  }
  const deadLinks = [...referenced].filter(r => !pageSet.has(canon(r))).sort();

  return {
    projectPath,
    fileCount: files.length,
    pages: [...new Set(pages)].sort(),
    apiRoutes: [...new Set(apiRoutes)].sort(),
    components,
    referencedRoutes: referenced.size,
    deadLinks,
    ok: pageSet.has('/') && deadLinks.length === 0,
  };
}
