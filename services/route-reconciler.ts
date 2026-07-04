/**
 * DWOMOH Route Reconciler
 *
 * The BUILD_SYSTEM_PROMPT instructs the model to declare a [ROUTE_MANIFEST]
 * and create a page file for every route it links to. On large single-pass
 * generations the model frequently DECLARES routes it never writes — leaving
 * <Link href="/x"> with no app/x/page.tsx. That is the root cause of the
 * "links don't work / pages are broken / app is incomplete" class of bugs.
 *
 * Until now the manifest was requested in the prompt but never read back, and
 * the only safety net (auditAndRepairRoutes) filled gaps with hollow
 * "coming soon" / "Loading content…" stubs.
 *
 * This module closes the loop deterministically (no running server, no
 * Playwright, no timing dependency):
 *   1. parseRouteManifest()        — read the declared pages back
 *   2. findMissingManifestPages()  — diff declared vs. files actually generated
 *   3. buildMissingPagesPrompt()   — ask the model to emit REAL pages for the gap
 *
 * The caller (generate action) runs the prompt through the same AI + parser it
 * already uses, then merges the resulting page files into the project before
 * anything is written to disk.
 */

export interface ProjectFileLike {
  path: string;
  content: string;
}

// ── 1. Parse the manifest ───────────────────────────────────────────────────

/**
 * Extract declared PAGE routes from the [ROUTE_MANIFEST] block.
 * Only the `pages:` line is used; api_routes are validated elsewhere.
 * Returns normalized routes (leading slash, no trailing slash), api routes
 * and obvious non-routes filtered out.
 */
export function parseRouteManifest(rawAiText: string): string[] {
  if (!rawAiText) return [];
  const block = rawAiText.match(/\[ROUTE_MANIFEST\]([\s\S]*?)\[\/ROUTE_MANIFEST\]/i);
  if (!block) return [];

  const pagesLine = block[1].match(/pages\s*:\s*([^\n\r]*)/i);
  if (!pagesLine) return [];

  const seen = new Set<string>();
  const routes: string[] = [];
  for (const raw of pagesLine[1].split(',')) {
    const r = raw.trim().split(/\s+/)[0]; // drop any inline comment after the route
    if (!r || !r.startsWith('/')) continue;
    if (r.startsWith('/api')) continue; // pages only
    const norm = r.length > 1 ? r.replace(/\/+$/, '') : r;
    if (seen.has(norm)) continue;
    seen.add(norm);
    routes.push(norm);
  }
  return routes;
}

// ── 2. Diff against generated files ──────────────────────────────────────────

/** Map a generated file path to the URL route it serves (stripping route groups). */
function filePathToRoute(path: string): string | null {
  if (/^(?:src\/)?app\/page\.[jt]sx?$/.test(path)) return '/';
  const m = path.match(/^(?:src\/)?app\/(.*?)\/page\.[jt]sx?$/);
  if (!m) return null;
  const seg = m[1]
    .replace(/\([^)]+\)\//g, '') // (group)/ → ''
    .replace(/\([^)]+\)$/, '') // trailing (group)
    .replace(/\/+$/, '');
  return seg ? '/' + seg : '/';
}

/**
 * Canonicalize a route so dynamic segments compare equal regardless of the
 * param name or bracket style: /products/[id], /products/:slug, /products/{x}
 * all collapse to /products/[x].
 */
function canonRoute(route: string): string {
  return (
    route
      .replace(/\[[^\]]+\]/g, '[x]')
      .replace(/:[A-Za-z0-9_]+/g, '[x]')
      .replace(/\{[^}]+\}/g, '[x]')
      .replace(/\/+$/, '') || '/'
  );
}

/** Declared pages that have no corresponding page file in the generated output. */
export function findMissingManifestPages(
  declared: string[],
  files: ProjectFileLike[],
): string[] {
  const existing = new Set<string>();
  for (const f of files) {
    const r = filePathToRoute(f.path);
    if (r) existing.add(canonRoute(r));
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const route of declared) {
    const c = canonRoute(route);
    if (existing.has(c) || seen.has(c)) continue;
    seen.add(c);
    missing.push(route);
  }
  return missing;
}

// ── 3. Build the fill prompt ─────────────────────────────────────────────────

/** The app/.../page.tsx path a missing route should be written to. */
export function routeToPagePath(route: string): string {
  if (route === '/') return 'app/page.tsx';
  const seg = route.replace(/^\/+/, '').replace(/\/+$/, '');
  return `app/${seg}/page.tsx`;
}

/**
 * Build a focused prompt asking the model to generate ONLY the missing pages,
 * with REAL content, using the home page + API routes as design/data context.
 * The output uses the <file path="…">…</file> format parsed by parseEditFormat.
 */
export function buildMissingPagesPrompt(
  missing: string[],
  files: ProjectFileLike[],
  specAnchor: string,
): string {
  const ctx: string[] = [];

  const home = files.find(f => /^(?:src\/)?app\/page\.[jt]sx?$/.test(f.path));
  if (home) {
    ctx.push(`=== app/page.tsx (home — match this design, palette, and components) ===\n${home.content.slice(0, 2500)}`);
  }

  const apis = files
    .filter(f => /^(?:src\/)?app\/api\/.*route\.[jt]sx?$/.test(f.path))
    .slice(0, 3);
  for (const a of apis) {
    ctx.push(`=== ${a.path} (API shape — fetch from here) ===\n${a.content.slice(0, 1400)}`);
  }

  return `${specAnchor}

These pages were declared in the project's ROUTE MANIFEST and are linked from the UI, but NO page file was generated for them. They currently 404 and make the app look broken and incomplete.

Create a COMPLETE, REAL page for EACH route below — matching this app's actual purpose. Do NOT output placeholders, "coming soon", or fake skeleton loaders:
${missing.map(r => `• ${r}  →  ${routeToPagePath(r)}`).join('\n')}

Requirements for every page:
1. Real, purpose-specific content for THIS app (use the SPECIFICATION above) — proper headings, sections, and interactive UI a real user would use.
2. If the page displays data, fetch it from the matching /api route with fetch(), and render genuine loading and empty states.
3. Match the home page's visual style below — same Tailwind palette, spacing, and component patterns.
4. Include working navigation (header/links) back to the main pages.
5. For dynamic routes ([id] / [slug]) use async params:
   export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; … }

${ctx.join('\n\n')}

Output ONLY the page files, each in EXACTLY this format with no extra prose:
<file path="app/example/page.tsx">...full file content...</file>`;
}
