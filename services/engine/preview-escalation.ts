/**
 * Server-side port of the Send button's 3-tier npm-install escalation
 * (previously only in app/builder/page.tsx's runBuildPipeline, lines
 * ~4628-4645), so the repaired engine's preview stage doesn't regress
 * behavior when it becomes the Send button's build core.
 *
 * This relocates EXISTING control flow — plain install, then --force, then
 * --force --omit=optional, never blocking the build even if all three fail
 * (some packages may already be present from a prior build) — built
 * entirely from services/project-runner.ts's existing installDependencies.
 * Not a new capability, just moved server-side.
 *
 * Wraps (does not replace) defaultOrchestratorDeps()'s own `startPreview`:
 * that function's success path assigns a closure variable
 * (`currentPreviewUrl`) that repairerDeps.getPreviewUrl() reads internally
 * (services/engine/repairer.ts:497) — replacing it outright would silently
 * disconnect the repairer's runtime-awareness during its own internal
 * verify calls. Instead: if the base startPreview fails on an install-
 * related error, pre-emptively run the escalated installs ourselves (so
 * most packages already land), then call the SAME base startPreview again
 * — its own (now-fast, since packages are present) install succeeds and it
 * sets currentPreviewUrl exactly as it always does.
 */
import type { OrchestratorDeps } from './orchestrator';

export type StartPreview = NonNullable<OrchestratorDeps['startPreview']>;

export function withInstallEscalation(base: StartPreview): StartPreview {
  return async (projectPath, signal) => {
    const log = (m: string) => console.log(`[preview-escalation][${new Date().toISOString()}] ${m}`);

    const first = await base(projectPath, signal);
    if (first.started || signal?.aborted) return first;

    log(`base startPreview failed (${first.error}) — escalating install with --force`);
    const { installDependencies } = await import('@/services/project-runner');
    let inst = await installDependencies(projectPath, ['--force'], signal);
    log(`install (--force) success=${inst.success}`);

    if (!inst.success && !signal?.aborted) {
      log('--force failed — retrying with --force --omit=optional');
      inst = await installDependencies(projectPath, ['--force', '--omit=optional'], signal);
      log(`install (--force --omit=optional) success=${inst.success}`);
    }

    // Never block on install failure — mirrors the old pipeline exactly:
    // some packages may already be present from a prior attempt, and the
    // dev server may still start correctly on retry.
    if (!inst.success) {
      log('all escalation strategies failed — retrying base startPreview anyway (some packages may already be present)');
    }

    if (signal?.aborted) return { url: null, started: false, error: 'Cancelled — preview stage was aborted' };

    // Re-run the SAME base startPreview so its own success path sets
    // currentPreviewUrl (repairerDeps.getPreviewUrl's source) correctly.
    return base(projectPath, signal);
  };
}
