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
import { addNavLink, routeToLabel } from './nav-template';
import { addDashboardResource } from './dashboard-template';
import { hasBreadcrumbs } from './breadcrumb-template';

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
// "auth" covers a combined signin/signup page (confirmed live: a generated
// app used exactly this route with a mode=signup/signin toggle, matching
// the SAME shape buildRouteStub's own auth-page template produces) — the
// same reasoning that excludes /login and /signup individually applies to
// a single page serving both. The (\/.*)? suffix ALSO excludes sub-paths
// like /auth/login, /auth/register — confirmed live: a dead-link fast-path
// created exactly these as separate stub pages (duplicating the combined
// /auth?mode= page), and without the suffix they were flagged as missing
// from nav even though they're auth-flow pages, not real navigable
// destinations, same as their exact-match counterparts.
const NAV_EXCLUDE_RE = /^\/(login|signup|register|sign-in|sign-up|signin|auth|logout|forgot-password|reset-password)(\/.*)?$/i;

registerIntegration({
  id: 'navigation',
  label: 'Navigation (Navbar / Sidebar / Footer)',
  category: 'core',
  appliesTo: () => true,
  detect(ctx: IntegrationContext): IntegrationGap[] {
    const navFiles = ctx.files.filter(f => NAV_FILE_RE.test(f.path));
    if (navFiles.length === 0) return [];
    const combined = navFiles.map(f => f.content).join('\n');
    const gaps: IntegrationGap[] = [];
    for (const route of new Set(ctx.routes)) {
      if (route === '/' || route.includes('[') || NAV_EXCLUDE_RE.test(route)) continue;
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
stubRule('search-indexing', 'Search indexing', 'core', () => true,
  'No search infrastructure exists in the generated-app template (no Elasticsearch/Algolia/SQLite-FTS setup). Registered now so a future phase that adds real search infra can activate this rule without redesigning the registry; until then it correctly reports no gaps rather than inventing a search feature outside the scope of "wiring."');
stubRule('permissions', 'Role-based permissions', 'core', () => true,
  'The `role` field IS tracked on every user (lib/managed/auth.ts, JWT payload), but planner.ts does not yet capture PER-ROUTE role requirements, so there is no signal to drive deterministic role-based middleware. Deferred pending a planner enhancement, not an infrastructure gap — registered for catalog completeness.');
stubRule('database-registration', 'Database schema registration', 'optional', (ctx) => ctx.fileSet.has('lib/managed/db.ts'),
  'Already satisfied by construction: crud-template.ts calls initTable() with an idempotent CREATE TABLE IF NOT EXISTS at the top of every generated CRUD route, self-registering its schema on first import. No separate registration step is needed or possible to "gap" — registered for catalog completeness.');
stubRule('migrations', 'Database migrations', 'optional', (ctx) => ctx.fileSet.has('lib/managed/db.ts'),
  'SQLite\'s idempotent CREATE TABLE IF NOT EXISTS (via initTable(), called at import time by every generated route) already serves as a zero-config migration mechanism for this template — there is no separate migration system to wire. Registered for catalog completeness; a future move to a schema-versioned database would activate a real implementation here.');
stubRule('analytics', 'Analytics', 'optional', (ctx) => ctx.fileSet.has('lib/managed/analytics.ts'),
  'No analytics provider exists in the managed-services template yet (lib/managed/ has db/auth/email/storage/qr, no analytics). Gate correctly never fires today; the moment a future phase adds lib/managed/analytics.ts, this rule activates with zero changes elsewhere.');
stubRule('notifications', 'Notifications', 'optional', (ctx) => ctx.fileSet.has('lib/managed/notifications.ts'),
  'No notification provider exists in the managed-services template yet. Same activation pattern as analytics above.');

export {};
