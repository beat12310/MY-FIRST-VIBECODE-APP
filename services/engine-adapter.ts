/**
 * Production adapter for the Send button's build flow — wraps
 * services/engine/orchestrator.ts's OrchestratorDeps with the side effects
 * the OLD action:'create' handler (app/api/chat/route.ts) performed, so the
 * repaired engine (navigation/permissions/schema/search/notifications,
 * stall-guard, adaptive timeout) can become the Send button's build core
 * WITHOUT losing billing, project persistence, or memory init.
 *
 * Deliberately additive: does not modify orchestrator.ts, builder.ts,
 * verifier.ts, or repairer.ts. Only the `build` stage is wrapped — plan,
 * verify, repair, learn, and startPreview are the same functions
 * `defaultOrchestratorDeps()` already builds.
 */
import type { OrchestratorDeps } from './engine/orchestrator';
import type { BuildResult } from './engine/types';

export interface ProductionBuildContext {
  ownerUserId: string;
  email?: string;
  /** Human-readable prompt, used for project memory + build history — the
   *  same value the old action:'create' handler read from body.originalPrompt. */
  originalPrompt: string;
  /** Forwarded from the conversation, if the caller already has one locked. */
  lockedSpec?: unknown;
}

// Mirrors the file filter defaultOrchestratorDeps()'s caller (runEngineBuild)
// uses internally — duplicated here (not exported from orchestrator.ts) to
// avoid touching that file for this migration.
async function readProjectFiles(projectPath: string): Promise<{ path: string; content: string }[]> {
  const { readFile, readdir, stat } = await import('fs/promises');
  const { join } = await import('path');
  const SKIP = new Set(['node_modules', '.next', '.git', '.dwomoh']);
  const out: { path: string; content: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      let s; try { s = await stat(p); } catch { continue; }
      if (s.isDirectory()) await walk(p);
      else if (/\.(tsx?|jsx?|css|json)$/.test(e)) {
        try { out.push({ path: p.replace(projectPath + '/', ''), content: await readFile(p, 'utf8') }); } catch { /* skip unreadable */ }
      }
    }
  };
  await walk(projectPath);
  return out;
}

/**
 * Runs the exact side effects the old action:'create' handler ran after
 * generateProject() succeeded (app/api/chat/route.ts:1369-1447), moved
 * verbatim — not rewritten — so behavior is provably identical: credit
 * deduction, a safe-tsconfig overwrite (AI models hallucinate compiler
 * options that crash `next dev`), project-manifest persistence, per-project
 * memory init, global build history, and an optional locked-spec save.
 */
export async function persistProjectSideEffects(result: BuildResult, ctx: ProductionBuildContext): Promise<{ projectId: string }> {
  const { join } = await import('path');
  const { readFile, writeFile } = await import('fs/promises');

  if (ctx.ownerUserId !== 'anonymous') {
    try {
      const { hasPermission } = await import('@/services/rbac');
      const bypassCredits = await hasPermission(ctx.ownerUserId, 'BYPASS_CREDITS');
      if (!bypassCredits) {
        const { deduct } = await import('@/services/credit-wallet');
        await deduct(ctx.ownerUserId, `generation: ${result.projectPath.split('/').pop()}`);
      }
    } catch (e) {
      console.warn('[engine-adapter] credit deduct skipped:', e instanceof Error ? e.message : e);
    }
  }

  {
    const tsconfigPath = join(result.projectPath, 'tsconfig.json');
    const SAFE_TSCONFIG = {
      compilerOptions: {
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./*'] } as Record<string, string[]>,
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    };
    try {
      const existing = JSON.parse(await readFile(tsconfigPath, 'utf-8').catch(() => '{}'));
      if (existing.compilerOptions?.paths) {
        Object.assign(SAFE_TSCONFIG.compilerOptions.paths, existing.compilerOptions.paths);
      }
    } catch { /* ignore parse errors */ }
    await writeFile(tsconfigPath, JSON.stringify(SAFE_TSCONFIG, null, 2) + '\n', 'utf-8').catch(() => {});
  }

  const { saveProject } = await import('@/services/project-store');
  const projectName = result.projectPath.split('/').pop() ?? 'project';
  const saved = await saveProject({
    ownerUserId: ctx.ownerUserId,
    name: projectName,
    description: '',
    projectPath: result.projectPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filesCount: result.filesCreated.length,
  });

  const { initProjectMemory, recordBuild } = await import('@/services/memory-store');
  await initProjectMemory({
    projectId: saved.id,
    name: projectName,
    originalPrompt: ctx.originalPrompt,
    projectPath: result.projectPath,
  });

  await recordBuild(projectName, ctx.originalPrompt, true);

  if (ctx.lockedSpec) {
    try {
      const { saveSpec } = await import('@/services/project-spec');
      await saveSpec(result.projectPath, ctx.lockedSpec as Parameters<typeof saveSpec>[1]);
    } catch { /* non-fatal, matches old action:'create' behavior */ }
  }

  return { projectId: saved.id };
}

/**
 * Builds an OrchestratorDeps set identical to defaultOrchestratorDeps()
 * except `build` is wrapped: the real buildApp() runs unchanged, and ONLY
 * on success (fresh files actually created) do we run the persistence side
 * effects above — matching where action:'create' ran in the old pipeline
 * (between generation and verification).
 */
export async function buildProductionOrchestratorDeps(ctx: ProductionBuildContext): Promise<OrchestratorDeps & { getProjectId: () => string | null }> {
  const { defaultOrchestratorDeps } = await import('./engine/orchestrator');
  const base = await defaultOrchestratorDeps(readProjectFiles);

  let projectId: string | null = null;

  const deps: OrchestratorDeps = {
    ...base,
    build: async (plan, signal) => {
      const result = await base.build(plan, signal);
      // GUARD: only persist a project that actually has a real Next.js entry
      // point — see the matching guard + comment in app/api/chat/route.ts's
      // action:'create' handler for the incident this fixes (crashed/
      // abandoned generations silently saved to the manifest as unusable
      // ghost projects that always failed to start a server).
      const hasEntryPoint = result.filesCreated.some(f =>
        /^(app\/page\.(tsx|js)|pages\/index\.(tsx|js))$/.test(f.path.replace(/^\.?\//, '')));
      if (result.filesCreated.length > 0 && result.isFreshFolder && hasEntryPoint) {
        const { projectId: pid } = await persistProjectSideEffects(result, ctx);
        projectId = pid;
      }
      return result;
    },
    startPreview: base.startPreview ? (await import('./engine/preview-escalation')).withInstallEscalation(base.startPreview) : undefined,
  };

  return { ...deps, getProjectId: () => projectId };
}

/**
 * The one function the Send button's build flow calls. Mirrors
 * runEngineBuild()'s contract (services/engine/orchestrator.ts) exactly, so
 * Engine Build/Test and the Send button converge on the same underlying
 * engine — this function just supplies production deps instead of the
 * defaults runEngineBuild() builds for the debug panel.
 */
export async function runProductionEngineBuild(
  prompt: string,
  ctx: ProductionBuildContext,
  onProgress?: OrchestratorDeps['onProgress'],
  sessionId?: string,
): Promise<{ report: Awaited<ReturnType<typeof import('./engine/orchestrator').runPipeline>>; projectId: string | null }> {
  const { runPipeline } = await import('./engine/orchestrator');
  const deps = await buildProductionOrchestratorDeps(ctx);
  const report = await runPipeline(prompt, { ...deps, onProgress }, ctx, sessionId);
  return { report, projectId: deps.getProjectId() };
}
