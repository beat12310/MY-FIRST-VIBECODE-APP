/**
 * DWOMOH VIBE CODE — Builder Engine (Step 3).
 *
 * Turns an AppPlan into REAL files in a FRESH project folder and returns a typed
 * BuildResult (facts only — it never declares success; the Verifier does that).
 *
 * Design:
 *  - Pure logic (parse, recover, gap-detect, assemble BuildResult) is separated
 *    from I/O, which is injected via BuilderDeps. This makes the Builder fully
 *    unit-testable WITHOUT Bedrock or the filesystem.
 *  - `defaultBuilderDeps()` lazily wires the real model + writer (buildWithAI,
 *    generateProject, route-reconciler). It is NOT imported anywhere else and is
 *    NOT wired into /api/chat.
 *
 * Guarantees:
 *  - "spec/prose only" (no real files / no root page) → NO placeholder is written
 *    and success is impossible (empty filesCreated).
 *  - Every build targets a unique fresh folder.
 *  - Files declared by the plan but missing get ONE targeted fill pass.
 */
import { parseProjectFormat, parseLooseProjectFiles } from '@/lib/json-parser';
import { extractProjectFiles } from './stream-parser';
import { fileToRoute, canon } from './verifier';
import { findMissingSharedImports, type MissingSharedFile } from './dependency-audit';
import type { AppPlan, BuildResult, GeneratedFile } from './types';

export interface BuilderFile { path: string; content: string }

export interface CreateResult {
  projectPath: string;
  foldersCreated: number;
  filesCreated: number;
  isFreshFolder: boolean;
}

export interface BuilderDeps {
  /** Call the model with a build prompt; returns raw text. (Non-streaming fallback.) */
  generate: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /**
   * Streaming generate: parses files INCREMENTALLY as Bedrock streams (per [FILE:]
   * delimiter), calling onFile(index, path) as each completes. Returns all files.
   * When provided, buildApp uses this instead of generate → no need to wait for the
   * whole 77k-char response, and structured files are captured without the loose
   * fallback (avoiding the second "fill" Bedrock call).
   */
  generateStream?: (prompt: string, onFile: (index: number, path: string) => void, signal?: AbortSignal) => Promise<{ files: BuilderFile[]; recovered: boolean }>;
  /** Write files into a brand-new folder; reports whether it was actually fresh. */
  createFreshProject: (projectName: string, files: BuilderFile[], buildId: string) => Promise<CreateResult>;
  /** Append more files into an existing project folder; returns count written. */
  appendFiles: (projectPath: string, files: BuilderFile[]) => Promise<number>;
  /** Generate ONLY the missing planned files (targeted fill). Optional. */
  fillMissing?: (plan: AppPlan, missing: string[], projectPath: string, signal?: AbortSignal) => Promise<BuilderFile[]>;
  /**
   * Generate any missing SHARED dependency files (types/lib/utils/constants/
   * components) that generated code imports but that don't exist — run BEFORE
   * verification so a broken import never survives to become a repair-loop
   * issue with no resolvable target path. Optional.
   */
  fillDependencies?: (plan: AppPlan, missing: MissingSharedFile[], projectPath: string, signal?: AbortSignal) => Promise<BuilderFile[]>;
}

const blog = (m: string) => console.log(`[builder][${new Date().toISOString()}] ${m}`);

/** Thrown when a signal aborts mid-build, so callers can tell "cancelled" from "failed". */
export class BuildAbortedError extends Error {
  constructor() { super('Build cancelled — orchestrator stage was aborted'); this.name = 'BuildAbortedError'; }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BuildAbortedError();
}

// ── Pure helpers (unit-testable) ──────────────────────────────────────────────
export function extractFiles(raw: string): { files: BuilderFile[]; recovered: boolean } {
  blog(`5) parseProjectFormat started (raw ${raw.length} chars)`);
  const strict = parseProjectFormat(raw);
  if (strict && strict.files.length > 0) {
    blog(`6) parseProjectFormat completed — ${strict.files.length} file(s) (strict, wrapped)`);
    return { files: strict.files, recovered: false };
  }
  // Wrapper-tolerant [FILE:] extraction — captures structured files even when the
  // model omitted [START_PROJECT] (the case that previously found 0 and forced the
  // costly loose fallback + second Bedrock "fill" call).
  const blocks = extractProjectFiles(raw);
  if (blocks.length > 0) {
    blog(`6) [FILE:]-block parse (wrapper optional) — ${blocks.length} file(s); loose fallback NOT used`);
    return { files: blocks, recovered: false };
  }
  blog('6) no structured [FILE:] blocks — falling back to loose parser');
  blog('7) parseLooseProjectFiles started');
  const loose = parseLooseProjectFiles(raw);
  blog(`7) parseLooseProjectFiles completed — ${loose.length} file(s) (loose)`);
  return { files: loose, recovered: loose.length > 0 };
}

// Root page = app/page.tsx, OR app/(group)/page.tsx — Next.js route groups are
// URL-transparent, so a landing page wrapped in e.g. (marketing) is still "/".
const ROOT_PAGE_RE = /^(?:src\/)?app\/(?:\([^/]+\)\/)?page\.[jt]sx?$/;

/** Path of the file that satisfies the root-page contract, or null if none does. */
export function findRootPage(files: BuilderFile[]): string | null {
  return files.find(f => ROOT_PAGE_RE.test(f.path))?.path ?? null;
}

export function hasRootPage(files: BuilderFile[]): boolean {
  return findRootPage(files) !== null;
}

/**
 * Planned page/api files that are not present on disk yet. Pages are matched by
 * RESOLVED ROUTE, not literal file path — a page the model placed inside a route
 * group (e.g. app/(marketing)/about/page.tsx) satisfies a plan entry for
 * app/about/page.tsx, since both resolve to the same "/about" route. Without this,
 * every route-group page would look "missing" and trigger a redundant fill call
 * that risks writing a second, conflicting page for the same route.
 */
export function missingPlannedFiles(plan: AppPlan, presentPaths: Set<string>): string[] {
  const presentRoutes = new Set<string>();
  for (const p of presentPaths) {
    const r = fileToRoute(p);
    if (r) presentRoutes.add(canon(r));
  }
  const missingPages = plan.pages.filter(p => !presentRoutes.has(canon(p.route))).map(p => p.filePath);
  const missingApi = plan.apiRoutes.filter(r => !presentPaths.has(r.filePath)).map(r => r.filePath);
  return [...missingPages, ...missingApi];
}

const bytesOf = (content: string): number => Buffer.byteLength(content, 'utf8');

export function buildPrompt(plan: AppPlan): string {
  const pages = plan.pages.map(p => `- ${p.route} (${p.filePath})${p.dynamic ? ' [dynamic]' : ''} — ${p.purpose}`).join('\n');
  const apis = plan.apiRoutes.map(r => `- ${r.route} (${r.filePath}) [${r.methods.join(', ')}] — ${r.purpose}`).join('\n');
  const comps = plan.components.map(c => `- ${c.name} (${c.filePath}) — ${c.purpose}`).join('\n');
  const caps = plan.resolvedCapabilities.map(rc => `- ${rc.capability} → call ${rc.configuration.proxyPath} (provider ${rc.provider}); never embed secrets`).join('\n');
  return [
    `Build a COMPLETE, working Next.js (App Router) application: ${plan.displayName}.`,
    `Type: ${plan.intent.label}. ${plan.description}`,
    ``,
    `CRITICAL OUTPUT ORDER — a long app can run out of response length before every`,
    `file is written. If that happens, the app must still be able to open in Preview:`,
    `an app with real pages and a stub API is usable and testable in a browser; an`,
    `app with perfect API routes and zero pages is not. Write files in EXACTLY this`,
    `order — build the application SHELL first, then features, then backend:`,
    `  1. package.json, tsconfig.json, next.config.js — minimal, no elaboration.`,
    `  2. app/page.tsx (or the correct route-group root page, e.g.`,
    `     app/(marketing)/page.tsx) — the ROOT page. Always immediately after`,
    `     config, before anything else. Never leave it for later.`,
    `  3. app/layout.tsx.`,
    `  4. Navigation (navbar/header component).`,
    `  5. Shared UI components (buttons, cards, layout primitives).`,
    `  6. Every other feature page listed below, in the order given.`,
    `  7. API routes.`,
    `  8. Backend infrastructure (lib/, data access, managed services).`,
    `  9. Optional files (SEO, sitemap, robots.txt, etc.) last.`,
    ``,
    `PAGES (create a real, functional page file for EVERY one — no placeholders):`,
    pages || '- /',
    ``,
    `API ROUTES (create each with real handlers):`,
    apis || '(none)',
    ``,
    `COMPONENTS:`,
    comps || '(none)',
    ``,
    plan.requiresAuth ? `AUTH: real signup, login, and protected dashboard. Forms must submit to the API routes.` : '',
    caps ? `\nPLATFORM SERVICES (call the proxy paths; keys stay server-side):\n${caps}` : '',
    plan.seo.sitemap ? `\nSEO: include sitemap.xml, robots.txt, and metadata.` : '',
    ``,
    `Output the project using the strict [START_PROJECT] ... [FILE: path] ... [END_PROJECT] format. Output code, not a specification.`,
  ].filter(Boolean).join('\n');
}

// ── Orchestrated build (uses injected deps) ──────────────────────────────────
export async function buildApp(plan: AppPlan, deps: BuilderDeps, signal?: AbortSignal): Promise<BuildResult> {
  const startedAt = new Date().toISOString();
  const logs: string[] = [];
  const buildId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const empty = (recovered: boolean): BuildResult => ({
    projectPath: '', isFreshFolder: false, filesCreated: [], foldersCreated: 0,
    startedAt, finishedAt: new Date().toISOString(), recoveredFromLooseFormat: recovered, logs,
  });

  blog(`1) buildApp started — project="${plan.projectName}", ${plan.pages.length} planned pages, ${plan.apiRoutes.length} api routes`);
  throwIfAborted(signal);

  // 1. Generate + parse. Prefer STREAMING (incremental parse per [FILE:] delimiter).
  const prompt = buildPrompt(plan);
  let files: BuilderFile[];
  let recovered: boolean;
  if (deps.generateStream) {
    blog('2) STREAMING Bedrock generate + incremental parse started');
    const genT0 = Date.now();
    const res = await deps.generateStream(prompt, (index, path) => {
      if (index === 1) blog(`first file parsed: ${path} (+${Date.now() - genT0}ms)`);
      else if (index === 10) blog(`tenth file parsed: ${path} (+${Date.now() - genT0}ms)`);
    }, signal);
    files = res.files;
    recovered = res.recovered;
    blog(`3/4/8) streaming complete — final file parsed; ${files.length} file(s) (recovered=${recovered}) in ${Date.now() - genT0}ms`);
  } else {
    blog('2) Bedrock call started (deps.generate)');
    const genT0 = Date.now();
    const raw = await deps.generate(prompt, signal);
    blog(`3) Bedrock response received after ${Date.now() - genT0}ms`);
    blog(`4) raw response length = ${raw.length} chars`);
    const ex = extractFiles(raw);
    files = ex.files;
    recovered = ex.recovered;
    blog(`8) file extraction count = ${files.length} (recovered=${recovered})`);
  }
  logs.push(`Parsed ${files.length} file(s)${recovered ? ' via loose recovery' : ''}.`);

  // The generate call above is the only thing an abort can interrupt mid-flight
  // (it rejects with BuildAbortedError/AbortedError, which propagates up through
  // this function naturally). This check catches the case where the signal fired
  // just as generation finished — don't start writing files after cancellation.
  throwIfAborted(signal);

  // 2. Root-page detection — logged unconditionally so a failed build always shows
  //    exactly what was parsed and why the guard did/didn't fire.
  const rootPage = findRootPage(files);
  blog(`8b) root page check — filesParsed=${files.length}, rootPage=${rootPage ?? 'NONE'}, hasRootPage=${rootPage !== null}`);
  logs.push(`Root page check: ${files.length} file(s) parsed; root page ${rootPage ? `found at ${rootPage}` : 'NOT found'}.`);

  // 2a. Zero files parsed — Bedrock returned prose/spec only. Never write a placeholder.
  if (files.length === 0) {
    blog('GUARD: zero files parsed — Bedrock returned prose/spec only');
    logs.push('Bedrock returned prose/spec only (no parseable [FILE:] blocks found). Refusing to write a placeholder; build fails.');
    return empty(recovered);
  }

  // 2b. Files parsed, but none satisfy the root-page contract (bare app/page.tsx or
  //     a route-group-wrapped app/(group)/page.tsx). Distinct from 2a: real files
  //     exist but were discarded because the root page is missing or undetected.
  if (!rootPage) {
    blog('GUARD: files parsed but no accepted root page — root page missing or detector failed');
    logs.push(`Root page missing or detector failed: parsed ${files.length} file(s) (${files.map(f => f.path).join(', ')}) but none matched app/page.tsx or app/(group)/page.tsx. Refusing to write a placeholder; build fails.`);
    return empty(recovered);
  }

  // 3. Write to a FRESH folder. (File writes themselves are fast, synchronous-ish
  //    fs operations — the abort check above is what actually matters; there's no
  //    slow network call between here and the write completing.)
  blog(`9) createFreshProject started — writing ${files.length} file(s)`);
  const cfpT0 = Date.now();
  const created = await deps.createFreshProject(plan.projectName, files, buildId);
  blog(`10) createFreshProject completed after ${Date.now() - cfpT0}ms — path=${created.projectPath}, fresh=${created.isFreshFolder}, files=${created.filesCreated}`);
  logs.push(`Created ${created.isFreshFolder ? 'FRESH' : 'EXISTING(!)'} folder ${created.projectPath} with ${created.filesCreated} file(s).`);

  const all: BuilderFile[] = [...files];
  const present = new Set(all.map(f => f.path));

  // 4. Structural gap vs plan → ONE targeted fill pass (real content, not stubs).
  blog('11) missingPlannedFiles check started');
  let missing = missingPlannedFiles(plan, present);
  blog(`11) missingPlannedFiles = ${missing.length}${missing.length ? ': ' + missing.join(', ') : ''}`);
  if (missing.length > 0) {
    logs.push(`Structural gap: ${missing.length} planned file(s) missing: ${missing.join(', ')}`);
    if (deps.fillMissing) {
      throwIfAborted(signal); // don't start a second Bedrock call after cancellation
      blog('12) targeted fill started (deps.fillMissing)');
      const fillT0 = Date.now();
      const extra = await deps.fillMissing(plan, missing, created.projectPath, signal);
      const usable = extra.filter(f => !present.has(f.path));
      if (usable.length > 0) {
        const n = await deps.appendFiles(created.projectPath, usable);
        usable.forEach(f => { all.push(f); present.add(f.path); });
        logs.push(`Targeted fill wrote ${n} missing file(s).`);
      }
      missing = missingPlannedFiles(plan, present);
      blog(`12) targeted fill completed after ${Date.now() - fillT0}ms — wrote ${usable.length}, still missing ${missing.length}`);
    }
    if (missing.length > 0) logs.push(`Still missing after fill (Verifier/Repairer will handle): ${missing.join(', ')}`);
  }

  // 5. Dependency audit — ensure every shared type/helper/util/model/constant/
  //    lib file the generated code imports actually exists, BEFORE verify runs.
  //    Without this, a missing shared import survives as a "Broken import"
  //    failure the generic repair path can't target (the failure detail is an
  //    import SPECIFIER, not a file path ending in .ts/.tsx) and repair stalls.
  if (deps.fillDependencies) {
    blog('14) dependency audit started');
    const missingDeps = findMissingSharedImports(all);
    blog(`14) dependency audit = ${missingDeps.length}${missingDeps.length ? ': ' + missingDeps.map(d => d.resolvedPath).join(', ') : ''}`);
    if (missingDeps.length > 0) {
      logs.push(`Dependency audit: ${missingDeps.length} missing shared file(s): ${missingDeps.map(d => d.resolvedPath).join(', ')}`);
      throwIfAborted(signal);
      const depT0 = Date.now();
      const depFiles = await deps.fillDependencies(plan, missingDeps, created.projectPath, signal);
      const usableDeps = depFiles.filter(f => !present.has(f.path));
      if (usableDeps.length > 0) {
        const n = await deps.appendFiles(created.projectPath, usableDeps);
        usableDeps.forEach(f => { all.push(f); present.add(f.path); });
        logs.push(`Dependency audit generated ${n} missing shared file(s).`);
      }
      blog(`14) dependency audit completed after ${Date.now() - depT0}ms — wrote ${usableDeps.length}`);
    }
  }

  // 5.5. Regenerate middleware.ts against the COMPLETE, final page list.
  // injectDeterministicAuthRoutes (called earlier, inside createFreshProject)
  // builds middleware.ts's PROTECTED_PATTERNS from whatever pages existed AT
  // THAT POINT — before the missingPlannedFiles/fillMissing pass above could
  // add MORE pages the initial AI response omitted. Confirmed live on a
  // fresh, otherwise fully-passing build: /billing and /settings pages
  // existed but were missing from middleware protection purely because they
  // didn't exist yet when middleware.ts was first written. Regenerating here
  // — after the file set is final — closes that gap unconditionally, with
  // zero Bedrock cost, rather than depending on a follow-up edit request
  // (services/engine/auth-template.ts's own patcher only fires when an edit
  // request happens to use auth-implying language).
  // Triggered on plan.requiresAuth, NOT `present.has('middleware.ts')` — the
  // files this function tracks (`all`/`present`) are only what the AI
  // generated plus fillMissing's output; middleware.ts itself is written by
  // a DEEPER phase inside createFreshProject (project-generator.ts's
  // injectDeterministicAuthRoutes) that this function never sees the output
  // of, so that file is never actually a member of `present`. requiresAuth
  // is set by the planner before generation even starts and is what decides
  // whether injectDeterministicAuthRoutes creates middleware.ts in the first
  // place, making it the reliable signal here.
  if (plan.requiresAuth) {
    const { buildMiddleware, deriveProtectedRoutes } = await import('./auth-template');
    const { fileToRoute } = await import('./verifier');
    const pageRoutes = all
      .filter(f => /\/page\.[jt]sx?$/.test(f.path))
      .map(f => fileToRoute(f.path))
      .filter((r): r is string => r !== null);
    const mw = buildMiddleware(deriveProtectedRoutes(pageRoutes));
    await deps.appendFiles(created.projectPath, [{ path: mw.filePath, content: mw.content }]);
    const existingMw = all.find(f => f.path === mw.filePath);
    if (existingMw) existingMw.content = mw.content; else all.push({ path: mw.filePath, content: mw.content });
    logs.push('Middleware regenerated against the complete, final page list.');
    blog(`14b) middleware regenerated — protecting: ${pageRoutes.filter(r => deriveProtectedRoutes([r]).length > 0).join(', ') || '(none)'}`);
  }

  // 5.7. Ensure the shared Breadcrumbs component exists whenever there's a
  // dynamic detail route to use it on. There's no safe deterministic hook to
  // AUTHOR a new dynamic-route page WITH breadcrumbs built in — dead-link
  // stubs are always literal paths (buildRouteStub), and a missing PLANNED
  // dynamic page falls through to the model like any other missing page —
  // so the model ends up writing these pages either way. What this step
  // guarantees is that a real, ready-to-import components/Breadcrumbs.tsx
  // always exists first, so the model (or the breadcrumbs Integration Rule's
  // repair prompt) has one consistent component to reference instead of
  // inventing a slightly different one on every generation.
  const hasDynamicRoute = all.some(f => /\/\[[^/]+\]\/page\.[jt]sx?$/.test(f.path));
  if (hasDynamicRoute && !present.has('components/Breadcrumbs.tsx')) {
    const { buildBreadcrumbsComponent } = await import('./breadcrumb-template');
    const bc = buildBreadcrumbsComponent();
    await deps.appendFiles(created.projectPath, [{ path: bc.filePath, content: bc.content }]);
    all.push({ path: bc.filePath, content: bc.content });
    present.add(bc.filePath);
    logs.push('Breadcrumbs component injected (dynamic detail route present).');
  }

  // 5.6. Initialize project memory. Confirmed live: .project-memory.json
  // never got created by the build pipeline at all — only the EDIT pipeline
  // created it, reactively, on the FIRST edit request (with a crude fallback
  // using the folder name as the "prompt", since the edit flow never has the
  // real one). Initializing it here means every generated app remembers its
  // architecture — pages, file tree, original intent — from the moment it
  // exists, not just after a user happens to make their first edit.
  try {
    const { initProjectMemory, updateProjectMemory } = await import('@/services/memory-store');
    const projectId = `proj_${Buffer.from(plan.projectName).toString('hex').slice(0, 12)}`;
    await initProjectMemory({
      projectId, name: plan.displayName || plan.projectName,
      originalPrompt: plan.description || plan.displayName || plan.projectName,
      projectPath: created.projectPath,
      purpose: plan.description,
    });
    await updateProjectMemory(created.projectPath, {
      buildStatus: 'success',
      fileTree: all.map(f => f.path).sort(),
      pages: plan.pages.map(p => p.route),
      components: all.filter(f => f.path.startsWith('components/')).map(f => f.path),
    });
    logs.push('Project memory initialized.');
  } catch { /* non-fatal — memory is a convenience layer for later edits, never blocks the build itself */ }

  // 6. Assemble BuildResult (facts only).
  const filesCreated: GeneratedFile[] = all.map(f => ({ path: f.path, bytes: bytesOf(f.content) }));
  blog(`13) BuildResult returned — ${filesCreated.length} file(s), ${created.foldersCreated} folder(s)`);
  return {
    projectPath: created.projectPath,
    isFreshFolder: created.isFreshFolder,
    filesCreated,
    foldersCreated: created.foldersCreated,
    startedAt,
    finishedAt: new Date().toISOString(),
    recoveredFromLooseFormat: recovered,
    logs,
  };
}

// ── Default (production) wiring — lazy, imported by nobody else, not on /api/chat ──
export async function defaultBuilderDeps(): Promise<BuilderDeps> {
  return {
    generate: async (prompt, signal) => {
      // Fast Bedrock health check BEFORE the long build call. If the model/region/
      // credentials are wrong, fail in ~20s with the EXACT reason instead of being
      // masked by the 180s build-stage timeout. Never fakes a build.
      const { bedrockHealthCheck } = await import('@/services/bedrock-health');
      const health = await bedrockHealthCheck('SONNET', undefined, signal);
      if (!health.ok) {
        const creds = health.credentials.accessKey && health.credentials.secretKey ? 'present' : 'MISSING';
        throw new Error(
          `Bedrock health check failed — model='${health.modelId}' region=${health.region} credentials=${creds} ` +
          `callStarted=${health.callStarted} responded=${health.responded}. Error: ${health.error}. Fix: ${health.recommendation}`,
        );
      }
      console.log(`[engine-build] Bedrock OK — model=${health.modelId} region=${health.region} probe=${health.latencyMs}ms; starting code generation`);
      const { buildWithAI } = await import('@/services/bedrock');
      const { BUILD_SYSTEM_PROMPT } = await import('@/lib/prompt-engineer');
      return buildWithAI(prompt, BUILD_SYSTEM_PROMPT, 'SONNET', signal);
    },
    // Streaming path — parses files incrementally as Bedrock streams; captures
    // structured [FILE:] blocks (wrapper optional) so the loose fallback + second
    // "fill" Bedrock call are avoided. This is what removes the 180s timeout.
    generateStream: async (prompt, onFile, signal) => {
      const { bedrockHealthCheck } = await import('@/services/bedrock-health');
      const health = await bedrockHealthCheck('SONNET', undefined, signal);
      if (!health.ok) {
        throw new Error(`Bedrock health check failed — model='${health.modelId}' region=${health.region}. Error: ${health.error}. Fix: ${health.recommendation}`);
      }
      const { buildWithAIStream } = await import('@/services/bedrock');
      const { BUILD_SYSTEM_PROMPT } = await import('@/lib/prompt-engineer');
      const { StreamingProjectParser, extractProjectFiles } = await import('./stream-parser');
      const files: BuilderFile[] = [];
      const parser = new StreamingProjectParser((idx, path, content) => { files.push({ path, content }); onFile(idx, path); });
      const raw = await buildWithAIStream(prompt, BUILD_SYSTEM_PROMPT, (delta) => parser.push(delta), 'SONNET', signal);
      parser.end();
      if (files.length > 0) return { files, recovered: false };
      // Model didn't use [FILE:] blocks — whole-string structured, then loose.
      const whole = extractProjectFiles(raw);
      if (whole.length > 0) return { files: whole, recovered: false };
      const { parseLooseProjectFiles } = await import('@/lib/json-parser');
      const loose = parseLooseProjectFiles(raw);
      return { files: loose, recovered: loose.length > 0 };
    },
    createFreshProject: async (projectName, files, buildId) => {
      const { generateProject } = await import('@/services/project-generator');
      const { GENERATED_ROOT } = await import('@/lib/workspace-paths');
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const target = join(GENERATED_ROOT, `${projectName}-${buildId}`);
      const existedBefore = existsSync(target);
      const r = await generateProject(projectName, files.map(f => ({ path: f.path, content: f.content })), { freshFolder: true, buildId });
      return { projectPath: r.projectPath, foldersCreated: r.foldersCreated, filesCreated: r.filesCreated, isFreshFolder: !existedBefore };
    },
    appendFiles: async (projectPath, files) => {
      const { writeFile, mkdir } = await import('fs/promises');
      const { join, dirname } = await import('path');
      let n = 0;
      for (const f of files) {
        const abs = join(projectPath, f.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content, 'utf8');
        n++;
      }
      return n;
    },
    fillMissing: async (plan, missing, _projectPath, signal) => {
      // FAST PATH: missing API routes matching the standard list/detail CRUD
      // shape (planner.ts's planApiRoutes) get a real, working handler from a
      // deterministic template — zero Bedrock cost — instead of being silently
      // dropped from this pass (the previous version only ever requested
      // missing PAGES here; missing API routes were never filled until a much
      // later, expensive single-file repair call).
      const { buildCrudRoute } = await import('./crud-template');
      const files: BuilderFile[] = [];
      const stillMissing: string[] = [];
      for (const m of missing) {
        const apiRoute = plan.apiRoutes.find(r => r.filePath === m);
        const crud = apiRoute ? buildCrudRoute(apiRoute, plan.dataModels) : null;
        if (crud) files.push({ path: crud.filePath, content: crud.content });
        else stillMissing.push(m);
      }

      const missingPages = stillMissing.filter(m => /\/page\.[jt]sx?$/.test(m));
      if (missingPages.length > 0) {
        const { buildMissingPagesPrompt } = await import('@/services/route-reconciler');
        const { buildWithAI } = await import('@/services/bedrock');
        const { BUILD_SYSTEM_PROMPT } = await import('@/lib/prompt-engineer');
        const spec = `Project: ${plan.displayName}. ${plan.description}`;
        const prompt = buildMissingPagesPrompt(missingPages.map(m => '/' + m.replace(/^app\//, '').replace(/\/page\.[jt]sx?$/, '')), [], spec);
        const raw = await buildWithAI(prompt, BUILD_SYSTEM_PROMPT, 'SONNET', signal);
        files.push(...extractFiles(raw).files);
      }
      return files;
    },
    fillDependencies: async (plan, missing, _projectPath, signal) => {
      // Shared files (types/lib/utils/constants/components) are too varied to
      // template deterministically — batch ALL of them into ONE Bedrock call,
      // giving the model the exact import statement + surrounding context from
      // every importer so it can infer the right shape (e.g. a Property
      // interface with the fields actually destructured by its callers).
      const { buildWithAI } = await import('@/services/bedrock');
      const { BUILD_SYSTEM_PROMPT } = await import('@/lib/prompt-engineer');
      const { parseEditFormat } = await import('@/services/file-editor');

      const system =
        `You are completing MISSING SHARED files for a ${plan.intent.appType} web app called "${plan.displayName}".\n` +
        `Return the COMPLETE content for EVERY file listed below, ALL in EXACTLY this format\n` +
        `(one [FILE: path] block per file, no other text):\n` +
        `[EDIT_START]\n[FILE: path/to/file1]\n<full content>\n[FILE: path/to/file2]\n<full content>\n[EDIT_END]\n` +
        `HARD RULES:\n` +
        `- Infer the correct shape (interface/type fields, function signatures, constant values) from how each file is imported and used below.\n` +
        `- Output real, complete, compiling TypeScript — no placeholders, no TODOs.\n` +
        `- Create ONLY the files listed below — do not touch any other file.`;

      const problems = missing.map((dep, idx) => {
        const importers = dep.importedBy.slice(0, 4).map(i => `   - ${i.file}: ${i.statement}`).join('\n');
        return `${idx + 1}. File to create: ${dep.resolvedPath} (imported as "${dep.spec}")\n   Imported by:\n${importers}`;
      }).join('\n\n');

      const prompt = [
        `App: ${plan.displayName} — ${plan.description}`,
        `Create these ${missing.length} missing shared file(s):`,
        problems,
        `Now output the complete content for EACH of the ${missing.length} files above.`,
      ].join('\n\n');

      const raw = await buildWithAI(prompt, `${BUILD_SYSTEM_PROMPT}\n\n${system}`, 'SONNET', signal);
      const edits = parseEditFormat(raw);
      const requested = new Set(missing.map(d => d.resolvedPath));
      // Safety filter: only accept the files actually requested — this pass
      // must not fan out into unrelated edits.
      return edits.filter(e => requested.has(e.path)).map(e => ({ path: e.path, content: e.content }));
    },
  };
}
