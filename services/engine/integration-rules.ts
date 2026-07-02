/**
 * Concrete integration rules registered into the Integration Registry.
 *
 * Detect-side note: rules never call fileToRoute()/import verifier.ts
 * themselves — verifier.ts is the single place that computes routes/
 * apiRoutes (it already needs to, for its own checks) and builds the
 * IntegrationContext once with that data already populated. Keeping the
 * dependency one-directional (verifier.ts -> this file, never the reverse)
 * avoids a circular import between the two.
 *
 * Apply-side note: every apply() below parses what it needs directly out of
 * the gap's own `detail`/`targetFile` (the same convention every repair
 * fast-path in this engine already uses) rather than reading ctx.routes/
 * ctx.apiRoutes — so repairer.ts can build a minimal context (routes/
 * apiRoutes left empty; only plan/files/fileSet populated) without needing
 * route-resolution logic of its own.
 */

import type { PlannedApiRoute } from './types';
import {
  registerIntegration, type IntegrationContext, type IntegrationGap, type IntegrationApplyResult,
} from './integration-registry';
import { deriveProtectedRoutes, routeToPatternSource, addProtectedRoute } from './auth-template';
import { addNavLink, routeToLabel, NAV_EXCLUDE_RE } from './nav-template';
import { NAV_REGISTRY_PATH, addRegistryEntry, idFromRoute } from './nav-registry-template';
import { addDashboardResource } from './dashboard-template';
import { hasBreadcrumbs } from './breadcrumb-template';
import { deriveRoleGates } from './permissions-template';
import { extractSchema, extractQueryReferences, detectSchemaGaps, synthesizeTableSchema } from './schema-template';
import { SEARCH_SERVICE_PATH, buildSearchService, hasSearchIndex, addSearchIndexCall, indexableColumns, isSearchFeatureFile } from './search-template';

async function writeFileAt(projectPath: string, relPath: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  const { join, dirname } = await import('path');
  const abs = join(projectPath, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}
async function readFileAt(projectPath: string, relPath: string): Promise<string | null> {
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  return readFile(join(projectPath, relPath), 'utf8').catch(() => null);
}

// ── navigation (core) ───────────────────────────────────────────────────────
const NAV_FILE_RE = /(?:^|\/)(Navbar|Footer|Sidebar)\.[jt]sx?$/;

registerIntegration({
  id: 'navigation',
  label: 'Navigation (Navbar / Sidebar / Footer)',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const candidateRoutes = [...new Set(ctx.routes)].filter(
      r => r !== '/' && !r.includes('[') && !NAV_EXCLUDE_RE.test(r),
    );

    // The registry (lib/managed/navigation.ts) is the reliable source of
    // truth once it exists — its shape is entirely engine-controlled, so
    // checking it is never ambiguous the way scanning arbitrary Navbar/
    // Footer JSX can be. Falls back to the old text-scan only for apps
    // built before this file existed.
    const registryFile = ctx.files.find(f => f.path === NAV_REGISTRY_PATH);
    if (registryFile) {
      const gaps: IntegrationGap[] = [];
      for (const route of candidateRoutes) {
        if (registryFile.content.includes(`href: '${route}'`) || registryFile.content.includes(`href: "${route}"`)) continue;
        gaps.push({
          integrationId: 'navigation',
          detail: `Route ${route} is not registered in the navigation registry: ${NAV_REGISTRY_PATH}`,
          targetFile: NAV_REGISTRY_PATH,
        });
      }
      return gaps;
    }

    const navFiles = ctx.files.filter(f => NAV_FILE_RE.test(f.path));
    if (navFiles.length === 0) return [];
    const combined = navFiles.map(f => f.content).join('\n');
    const gaps: IntegrationGap[] = [];
    for (const route of candidateRoutes) {
      if (combined.includes(`'${route}'`) || combined.includes(`"${route}"`)) continue;
      gaps.push({
        integrationId: 'navigation',
        detail: `Route ${route} is not registered in navigation: ${navFiles[0].path}`,
        targetFile: navFiles[0].path,
      });
    }
    return gaps;
  },
  async apply(gap, projectPath): Promise<IntegrationApplyResult | null> {
    if (gap.targetFile === NAV_REGISTRY_PATH) {
      const m = gap.detail.match(/^Route (\S+) is not registered in the navigation registry: /);
      if (!m) return null;
      const route = m[1];
      const content = await readFileAt(projectPath, NAV_REGISTRY_PATH);
      if (!content) return null;
      const result = addRegistryEntry(content, { id: idFromRoute(route), href: route, label: routeToLabel(route), order: 9999 });
      if (!result.changed) return null;
      await writeFileAt(projectPath, NAV_REGISTRY_PATH, result.content);
      return { changedFiles: [NAV_REGISTRY_PATH] };
    }

    const m = gap.detail.match(/^Route (\S+) is not registered in navigation: /);
    if (!m) return null;
    const route = m[1];
    const content = await readFileAt(projectPath, gap.targetFile);
    if (!content) return null;
    const { patched, changed } = addNavLink(content, route, routeToLabel(route));
    if (!changed) return null;
    await writeFileAt(projectPath, gap.targetFile, patched);
    return { changedFiles: [gap.targetFile] };
  },
});

// ── middleware-protection (core) ────────────────────────────────────────────
// Moved here verbatim from verifier.ts's previous inline unprotectedRoutes
// computation — same algorithm, now the registry's single source of truth
// instead of logic embedded directly in analyzeStatic().
registerIntegration({
  id: 'middleware-protection',
  label: 'Middleware route protection',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    if (!ctx.plan.requiresAuth) return [];
    const mwFile = ctx.files.find(f => f.path === 'middleware.ts');
    if (!mwFile) return [];
    const expectedProtected = deriveProtectedRoutes([...new Set(ctx.routes)]);
    const gaps: IntegrationGap[] = [];
    for (const r of expectedProtected) {
      if (!mwFile.content.includes(routeToPatternSource(r))) {
        gaps.push({
          integrationId: 'middleware-protection',
          detail: `Unprotected route ${r} — middleware.ts does not cover it: middleware.ts`,
          targetFile: 'middleware.ts',
        });
      }
    }
    return gaps;
  },
  async apply(gap, projectPath): Promise<IntegrationApplyResult | null> {
    const m = gap.detail.match(/^Unprotected route (\S+) — middleware\.ts does not cover it: middleware\.ts$/);
    if (!m) return null;
    const content = await readFileAt(projectPath, 'middleware.ts');
    if (!content) return null;
    const { patched, changed } = addProtectedRoute(content, m[1]);
    if (!changed) return null;
    await writeFileAt(projectPath, 'middleware.ts', patched);
    return { changedFiles: ['middleware.ts'] };
  },
});

// ── permissions (core) ───────────────────────────────────────────────────────
// Upgraded from an honest stub: role NAMES are inherently app-specific data
// (Admin/Worker/Promoter for an event platform, Admin/Vendor/Customer for a
// marketplace) so they can't be invented from a generic rule — but once the
// app's own route structure reveals a role-like section
// (permissions-template.ts's deriveRoleGates), enforcing it is fully
// deterministic.
//
// apply() derives page/API routes directly from ctx.files rather than
// ctx.routes/ctx.apiRoutes — those are only reliably populated at VERIFY
// time (computed by verifier.ts); repairer.ts's generic dispatch passes a
// minimal context with both left empty, since every OTHER rule's apply()
// only needs gap.detail/targetFile. Full middleware regeneration (not a
// surgical patch) is used here deliberately: unlike middleware-protection's
// single-array append, a FIRST role gate requires adding several new
// structural pieces at once (a jose import, JWT_SECRET, the ROLE_PATTERNS
// array, the role-check block, a denyAccess function, matcher entries) —
// safely splicing all of that into a middleware.ts of unknown existing
// shape is far riskier than regenerating from the same deterministic
// template that already builds it correctly the first time.
function localFileToRoute(path: string): string | null {
  const m = /^(?:src\/)?app\/page\.[jt]sx?$/.test(path) ? '' : path.match(/^(?:src\/)?app\/(.*?)\/page\.[jt]sx?$/)?.[1];
  if (m === undefined) return null;
  const seg = m.split('/').filter(s => !/^\(.*\)$/.test(s)).join('/');
  return seg ? '/' + seg : '/';
}
function deriveRoutesFromFiles(files: { path: string }[]): { pageRoutes: string[]; apiRoutes: string[] } {
  const pageRoutes: string[] = [], apiRoutes: string[] = [];
  for (const f of files) {
    const r = localFileToRoute(f.path);
    if (r) pageRoutes.push(r);
    if (/^(?:src\/)?app\/api\/.*route\.[jt]sx?$/.test(f.path)) {
      apiRoutes.push('/' + f.path.replace(/^(?:src\/)?app\//, '').replace(/\/route\.[jt]sx?$/, ''));
    }
  }
  return { pageRoutes, apiRoutes };
}

registerIntegration({
  id: 'permissions',
  label: 'Role-based permissions',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    if (!ctx.plan.requiresAuth) return [];
    const mwFile = ctx.files.find(f => f.path === 'middleware.ts');
    if (!mwFile) return [];
    const roleGates = deriveRoleGates([...new Set(ctx.routes)], [...new Set(ctx.apiRoutes)]);
    const gaps: IntegrationGap[] = [];
    for (const g of roleGates) {
      const pagePattern = routeToPatternSource(g.prefix);
      const apiPattern = routeToPatternSource('/api' + g.prefix);
      if (!mwFile.content.includes(pagePattern) || !mwFile.content.includes(apiPattern)) {
        gaps.push({
          integrationId: 'permissions',
          detail: `Role gate ${g.prefix} (role: ${g.role}) is not enforced — middleware.ts does not cover it: middleware.ts`,
          targetFile: 'middleware.ts',
        });
      }
    }
    return gaps;
  },
  async apply(_gap, projectPath, ctx): Promise<IntegrationApplyResult | null> {
    const content = await readFileAt(projectPath, 'middleware.ts');
    if (!content) return null;
    const { pageRoutes, apiRoutes } = deriveRoutesFromFiles(ctx.files);
    const roleGates = deriveRoleGates(pageRoutes, apiRoutes);
    if (roleGates.length === 0) return null;
    const { buildMiddleware } = await import('./auth-template');
    const mw = buildMiddleware(deriveProtectedRoutes(pageRoutes), roleGates);
    if (mw.content === content) return null;
    await writeFileAt(projectPath, 'middleware.ts', mw.content);
    return { changedFiles: ['middleware.ts'] };
  },
});

// ── api-registration (core) ─────────────────────────────────────────────────
// Moved here verbatim from verifier.ts's previous inline orphanedApiCalls
// computation, and repairer.ts's previous inline orphanedApiMatch fast-path.
const NON_RESOURCE_SEGMENT = /^(stats|summary|search|export|import|dashboard|me|profile|login|register|logout|session|health|status|ping)$/i;

registerIntegration({
  id: 'api-registration',
  label: 'API route registration',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const knownApiPaths = new Set([...ctx.apiRoutes, ...ctx.plan.apiRoutes.map(r => r.route)]);
    const fetchCallRe = /(?:fetch|axios(?:\.(?:get|post|put|patch|delete))?)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
    const gaps: IntegrationGap[] = [];
    for (const f of ctx.files) {
      if (!/\.(tsx?|jsx?)$/.test(f.path) || /^(?:src\/)?app\/api\//.test(f.path)) continue;
      let m: RegExpExecArray | null;
      const re = new RegExp(fetchCallRe);
      while ((m = re.exec(f.content))) {
        const raw = m[1].split('?')[0].replace(/\$\{[^}]+\}/g, '[id]');
        if (!raw.startsWith('/api/')) continue;
        // NOTE: intentionally does NOT also accept the route with its
        // trailing "[id]" stripped as "close enough" — a list route
        // (/api/courses) and its detail route (/api/courses/[id]) are
        // SEPARATE, independent files in Next.js. A missing detail route is
        // a real 404 for GET/PUT/DELETE-by-id regardless of whether the
        // list route happens to exist. An earlier version of this check did
        // fall back to the stripped form and silently missed exactly this
        // case — caught by a test exercising "list route exists, detail
        // route doesn't" specifically, a combination not covered by the
        // live apps tested when this detection was first built.
        if (knownApiPaths.has(raw)) continue;
        const resolvedFile = `app${raw}/route.ts`;
        gaps.push({
          integrationId: 'api-registration',
          detail: `${f.path} calls ${raw}, but the route was never created: ${resolvedFile}`,
          targetFile: resolvedFile,
        });
      }
    }
    return gaps;
  },
  async apply(gap, projectPath, ctx): Promise<IntegrationApplyResult | null> {
    const m = gap.detail.match(/, but the route was never created: (app\/api\/\S+\/route\.[jt]sx?)$/);
    if (!m) return null;
    const filePath = m[1];
    const routeUrl = '/' + filePath.replace(/^app\//, '').replace(/\/route\.[jt]sx?$/, '');
    const isDetail = /\[id\]$/.test(routeUrl);
    const resourceSegment = routeUrl.split('/').filter(Boolean).at(isDetail ? -2 : -1) ?? '';
    if (NON_RESOURCE_SEGMENT.test(resourceSegment)) return null; // special-purpose endpoint — defer to the model
    const synthesizedRoute: PlannedApiRoute = {
      route: routeUrl, filePath,
      methods: isDetail ? ['GET', 'PUT', 'DELETE'] : ['GET', 'POST'],
      purpose: 'Auto-generated for a call the app made without ever declaring this route.',
    };
    const { buildCrudRoute } = await import('./crud-template');
    const crud = buildCrudRoute(synthesizedRoute, ctx.plan.dataModels);
    if (!crud) return null;
    await writeFileAt(projectPath, crud.filePath, crud.content);
    return { changedFiles: [crud.filePath] };
  },
});

// ── project-memory (core) ───────────────────────────────────────────────────
registerIntegration({
  id: 'project-memory',
  label: 'Project memory',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    if (ctx.fileSet.has('.project-memory.json')) return [];
    return [{
      integrationId: 'project-memory',
      detail: 'Project memory (.project-memory.json) was never initialized: .project-memory.json',
      targetFile: '.project-memory.json',
    }];
  },
  async apply(_gap, projectPath, ctx): Promise<IntegrationApplyResult | null> {
    const { initProjectMemory, updateProjectMemory } = await import('@/services/memory-store');
    const projectId = `proj_${Buffer.from(ctx.plan.projectName).toString('hex').slice(0, 12)}`;
    await initProjectMemory({
      projectId, name: ctx.plan.displayName || ctx.plan.projectName,
      originalPrompt: ctx.plan.description || ctx.plan.displayName || ctx.plan.projectName,
      projectPath, purpose: ctx.plan.description,
    });
    await updateProjectMemory(projectPath, {
      buildStatus: 'success',
      fileTree: ctx.files.map(f => f.path).sort(),
      pages: ctx.plan.pages.map(p => p.route),
      components: ctx.files.filter(f => f.path.startsWith('components/')).map(f => f.path),
    });
    return { changedFiles: ['.project-memory.json'] };
  },
});

// ── dashboard-widgets (optional — requires a dashboard page) ───────────────
registerIntegration({
  id: 'dashboard-widgets',
  label: 'Dashboard cards/widgets',
  category: 'optional',
  appliesTo: (ctx: IntegrationContext) => ctx.fileSet.has('app/dashboard/page.tsx'),
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const dash = ctx.files.find(f => f.path === 'app/dashboard/page.tsx');
    if (!dash) return [];
    const gaps: IntegrationGap[] = [];
    for (const apiPath of new Set(ctx.apiRoutes)) {
      if (apiPath.includes('[') || /^\/api\/auth\//.test(apiPath)) continue; // detail/auth routes aren't stat-widget candidates
      const seg = apiPath.split('/').filter(Boolean).at(-1) ?? '';
      if (NON_RESOURCE_SEGMENT.test(seg)) continue;
      if (dash.content.includes(`'${apiPath}'`) || dash.content.includes(`"${apiPath}"`)) continue;
      gaps.push({
        integrationId: 'dashboard-widgets',
        detail: `Resource ${apiPath} is not represented as a dashboard widget: app/dashboard/page.tsx`,
        targetFile: 'app/dashboard/page.tsx',
      });
    }
    return gaps;
  },
  async apply(gap, projectPath): Promise<IntegrationApplyResult | null> {
    const m = gap.detail.match(/^Resource (\/api\/\S+) is not represented as a dashboard widget: /);
    if (!m) return null;
    const apiPath = m[1];
    const key = apiPath.replace(/^\/api\//, '').replace(/\//g, '_');
    const href = apiPath.replace(/^\/api/, '');
    const content = await readFileAt(projectPath, gap.targetFile);
    if (!content) return null;
    const { patched, changed } = addDashboardResource(content, key, routeToLabel(href), href, apiPath);
    if (!changed) return null;
    await writeFileAt(projectPath, gap.targetFile, patched);
    return { changedFiles: [gap.targetFile] };
  },
});

// ── breadcrumbs (optional — requires at least one dynamic detail route) ────
registerIntegration({
  id: 'breadcrumbs',
  label: 'Breadcrumbs on dynamic detail routes',
  category: 'optional',
  appliesTo: (ctx: IntegrationContext) => ctx.routes.some(r => r.includes('[')),
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const gaps: IntegrationGap[] = [];
    for (const f of ctx.files) {
      if (!/\/\[[^/]+\]\/page\.[jt]sx?$/.test(f.path)) continue;
      if (hasBreadcrumbs(f.content)) continue;
      gaps.push({
        integrationId: 'breadcrumbs',
        detail: `Dynamic detail page is missing breadcrumb navigation: ${f.path}`,
        targetFile: f.path,
      });
    }
    return gaps;
  },
  // Deliberately declines every time — see breadcrumb-template.ts's module
  // doc for why retrofitting arbitrary AI-authored JSX via regex is too
  // risky to do deterministically. New dynamic-detail stubs get breadcrumbs
  // built in from creation (buildDynamicRouteStubWithBreadcrumbs); existing
  // pages missing one fall through to the model, which can safely reason
  // about that page's actual JSX structure.
  async apply(): Promise<IntegrationApplyResult | null> { return null; },
});

// ── structurally-guaranteed / already-covered-elsewhere (core, no-op) ──────
// Registered for catalog completeness per the engine's full integration
// surface — each of these either has no possible gap given how Next.js's
// App Router works, or is already fully covered by another registered rule.
function noOpRule(id: string, label: string, note: string) {
  registerIntegration({
    id, label, category: 'core',
    appliesTo: () => true,
    detect: () => [],
    async apply() { return null; },
    note,
  });
}
noOpRule('routing', 'Routing', 'Next.js App Router file-based routing — a file existing at the right path IS the registration; file existence itself is guaranteed by the missing-planned-file fill pass and the api-registration rule above.');
noOpRule('layout-hierarchy', 'Layout hierarchy', 'No separate DashboardLayout pattern exists in the generated-app template (confirmed: no layout.tsx beyond the single root app/layout.tsx across sampled apps) — every page is already wrapped by the root layout via Next.js App Router structure. Nothing to additionally wire.');
noOpRule('dependency-graph', 'Internal dependency graph', 'Computed fresh on every read by project-map.ts (import graph + fetch-call edges), not a static artifact that can drift out of sync — there is no "gap" to detect, only a live computation to consult.');
noOpRule('authentication', 'Authentication', 'Fully covered by the deterministic auth-route injection (project-generator.ts injectDeterministicAuthRoutes) at build time and the middleware-protection rule above at verify/repair time — registered separately here only for catalog visibility, since it is a distinct concern (route auth CONTRACT vs which pages REQUIRE auth) sharing the same underlying mechanism.');

// ── honest stubs: no underlying infra exists yet in the template ───────────
function stubRule(id: string, label: string, category: 'core' | 'optional', appliesTo: (ctx: IntegrationContext) => boolean, note: string) {
  registerIntegration({
    id, label, category,
    appliesTo,
    detect: () => [],
    async apply() { return null; },
    note,
  });
}
// ── search-indexing (optional — requires a search feature + the managed DB) ──
// Upgraded from an honest stub now that SQLite FTS5 was confirmed to work
// (including the external-content sync-trigger pattern, tested live against
// a real better-sqlite3 install) and chosen as the architecture consistent
// with this template's zero-config managed-service philosophy.
//
// Deliberately narrow scope: this rule NEVER creates or rewrites an API
// route — that's api-registration's job for a missing route, and rewriting
// an EXISTING route's own query logic carries the same risk as any other
// retrofit-into-arbitrary-code case in this engine (breadcrumbs, nav) — so
// it isn't attempted here either. This rule only ensures the underlying
// FTS5 index exists for whatever table a search feature queries, so real
// search infrastructure (searchRows()) is available to call into, whether
// or not the route currently uses it.
//
// Detection signal lives in search-template.ts (isSearchFeatureFile) so both
// this rule and builder.ts's build-time injection step share one definition
// of "this file implements a search feature" — see that module for the full
// rationale, including the live evidence that motivated the two-signal design.

registerIntegration({
  id: 'search-indexing',
  label: 'Search indexing (SQLite FTS5)',
  category: 'optional',
  appliesTo: (ctx: IntegrationContext) => ctx.fileSet.has('lib/managed/db.ts') && ctx.files.some(isSearchFeatureFile),
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const searchFeatureFiles = ctx.files.filter(isSearchFeatureFile);
    if (searchFeatureFiles.length === 0) return [];
    const searchServiceFile = ctx.files.find(f => f.path === SEARCH_SERVICE_PATH);
    const schema = extractSchema(ctx.files);
    const refs = extractQueryReferences(searchFeatureFiles);
    const gaps: IntegrationGap[] = [];
    const seenTables = new Set<string>();
    for (const ref of refs) {
      if (seenTables.has(ref.table) || !schema.has(ref.table)) continue; // missing table entirely is database-schema's concern, not ours
      seenTables.add(ref.table);
      if (searchServiceFile && hasSearchIndex(searchServiceFile.content, ref.table)) continue;
      gaps.push({
        integrationId: 'search-indexing',
        detail: `Table ${ref.table} (queried by a search feature) has no FTS5 search index: ${SEARCH_SERVICE_PATH}`,
        targetFile: SEARCH_SERVICE_PATH,
      });
    }
    return gaps;
  },
  async apply(gap, projectPath, ctx): Promise<IntegrationApplyResult | null> {
    const m = gap.detail.match(/^Table (\w+) \(queried by a search feature\) has no FTS5 search index: /);
    if (!m) return null;
    const table = m[1];
    const schema = extractSchema(ctx.files);
    const tableSchema = schema.get(table);
    if (!tableSchema) return null;
    const columns = indexableColumns([...tableSchema.columns]);
    if (columns.length === 0) return null;
    const existing = await readFileAt(projectPath, SEARCH_SERVICE_PATH);
    const base = existing ?? buildSearchService().content;
    const { patched, changed } = addSearchIndexCall(base, table, columns);
    if (!changed && existing !== null) return null;
    await writeFileAt(projectPath, SEARCH_SERVICE_PATH, patched);
    return { changedFiles: [SEARCH_SERVICE_PATH] };
  },
});

stubRule('migrations', 'Database migrations', 'optional', (ctx) => ctx.fileSet.has('lib/managed/db.ts'),
  'SQLite\'s idempotent CREATE TABLE IF NOT EXISTS (via initTable(), called at import time by every generated route) already serves as a zero-config migration mechanism for this template — there is no separate migration system to wire. The "database-schema" rule actively VERIFIES this mechanism is working (every table/column a query references actually has a matching initTable schema) rather than just assuming it; registered here for catalog completeness under the historical "migrations" name.');

// ── database-schema (optional — requires the managed DB) ────────────────────
// Upgraded from an honest stub: crud-template.ts's initTable() calls were
// ASSUMED to keep schema in sync with queries, never actively verified — if
// the model writes a custom route bypassing the template, or a query
// drifts out of sync with its own table's columns, the first sign was a
// runtime "no such table"/"no such column" SQL error, not a build-time
// signal. See schema-template.ts for the extraction/cross-reference logic.
registerIntegration({
  id: 'database-schema',
  label: 'Database schema (tables, columns, foreign keys)',
  category: 'optional',
  appliesTo: (ctx: IntegrationContext) => ctx.fileSet.has('lib/managed/db.ts'),
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const schema = extractSchema(ctx.files);
    const refs = extractQueryReferences(ctx.files);
    const schemaGaps = detectSchemaGaps(schema, refs);
    return schemaGaps.map(g => {
      if (g.kind === 'missing-table') {
        return {
          integrationId: 'database-schema',
          detail: `Table ${g.table} is missing (referenced in ${g.file}), columns needed: ${(g.columns ?? []).join(',')}: ${g.file}`,
          targetFile: g.file,
        };
      }
      if (g.kind === 'missing-column') {
        return {
          integrationId: 'database-schema',
          detail: `Column ${g.column} is missing from table ${g.table} (referenced in ${g.file}): ${g.file}`,
          targetFile: g.file,
        };
      }
      return {
        integrationId: 'database-schema',
        detail: `Dangling foreign key: table ${g.table} column ${g.column} ${g.file}`,
        targetFile: '',
      };
    });
  },
  async apply(gap, projectPath): Promise<IntegrationApplyResult | null> {
    const missingTableMatch = gap.detail.match(/^Table (\w+) is missing \(referenced in ([^)]+)\), columns needed: ([^:]*): /);
    if (missingTableMatch) {
      const [, table, file, colsStr] = missingTableMatch;
      const columns = colsStr ? colsStr.split(',').filter(Boolean) : [];
      const content = await readFileAt(projectPath, file);
      if (content === null) return null;
      const createTableSql = synthesizeTableSchema(table, columns);
      // Inserted right after the last import line, matching where
      // crud-template.ts's own generated routes place their initTable()
      // call — new code, so there's no existing content to preserve here.
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) if (/^import\s/.test(lines[i])) lastImportIdx = i;
      const injection = `\ninitTable(\`${createTableSql}\`);`;
      const needsImport = !/from ['"]@\/lib\/managed\/db['"]/.test(content);
      const importLine = needsImport ? `import { initTable } from '@/lib/managed/db';\n` : '';
      lines.splice(lastImportIdx + 1, 0, importLine + injection);
      await writeFileAt(projectPath, file, lines.join('\n'));
      return { changedFiles: [file] };
    }

    const missingColMatch = gap.detail.match(/^Column (\w+) is missing from table (\w+) \(referenced in ([^)]+)\): /);
    if (missingColMatch) {
      const [, column, table, file] = missingColMatch;
      const content = await readFileAt(projectPath, file);
      if (content === null) return null;
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) if (/^import\s/.test(lines[i])) lastImportIdx = i;
      const needsImport = !/addColumnIfMissing/.test(content);
      const importLine = needsImport ? `import { addColumnIfMissing } from '@/lib/managed/db';\n` : '';
      const injection = `\naddColumnIfMissing('${table}', '${column}', 'TEXT');`;
      lines.splice(lastImportIdx + 1, 0, importLine + injection);
      await writeFileAt(projectPath, file, lines.join('\n'));
      return { changedFiles: [file] };
    }

    // Dangling foreign keys decline — safely synthesizing the referenced
    // table's FULL intended schema (not just the columns one query
    // happens to touch) risks guessing wrong; the model can see the
    // relationship's actual usage across the codebase and infer it properly.
    return null;
  },
});
stubRule('analytics', 'Analytics', 'optional', (ctx) => ctx.fileSet.has('lib/managed/analytics.ts'),
  'No analytics provider exists in the managed-services template yet (lib/managed/ has db/auth/email/storage/qr, no analytics). Gate correctly never fires today; the moment a future phase adds lib/managed/analytics.ts, this rule activates with zero changes elsewhere.');
stubRule('notifications', 'Notifications', 'optional', (ctx) => ctx.fileSet.has('lib/managed/notifications.ts'),
  'No notification provider exists in the managed-services template yet. Same activation pattern as analytics above.');

export {};
