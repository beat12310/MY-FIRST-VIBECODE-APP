/**
 * DWOMOH VIBE CODE — Engine Build Registry (single-flight lock).
 *
 * Guarantees that AT MOST ONE build pipeline runs per project at a time, so a
 * second /api/engine-build-stream request (EventSource auto-reconnect after a
 * proxy/heartbeat drop, a browser refresh, a duplicate tab, or a rapid re-click)
 * can NOT spawn a second buildApp()/Bedrock stream for the same project.
 *
 * Scope: an in-process module singleton. Correct for localhost (one Next server)
 * and the single Fargate worker container (all /api routes share one Node
 * process). A multi-instance deployment would need a distributed lock (DynamoDB
 * conditional put) — noted for later; not required for the current topology.
 *
 * Pure/standalone: no engine or AWS imports, fully unit-testable.
 */

export interface ActiveBuild {
  sessionId: string;
  projectKey: string;
  prompt: string;
  startedAt: number;   // epoch ms
}

/** A lock is considered stale (crashed without release) after this long. */
const STALE_MS = 15 * 60 * 1000; // 15 min — longer than the 10-min build cap.

const active = new Map<string, ActiveBuild>();

/** Stable project identity derived from the prompt. Same prompt → same key. */
export function projectKeyFromPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

/** Unique id for one build attempt. Included in every log line for correlation. */
export function newSessionId(): string {
  return `bs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function evictIfStale(key: string): void {
  const cur = active.get(key);
  if (cur && Date.now() - cur.startedAt > STALE_MS) active.delete(key);
}

/** The build currently running for a project, if any (after stale eviction). */
export function getActiveBuild(projectKey: string): ActiveBuild | null {
  evictIfStale(projectKey);
  return active.get(projectKey) ?? null;
}

export type AcquireResult =
  | { ok: true; build: ActiveBuild }
  | { ok: false; reason: 'already_active'; active: ActiveBuild };

/**
 * Try to become the single owner of this project's build.
 *  - ok:true  → caller owns the lock and MUST call release() in a finally.
 *  - ok:false → a build is already active; caller must NOT start a pipeline.
 */
export function tryAcquire(projectKey: string, sessionId: string, prompt: string): AcquireResult {
  evictIfStale(projectKey);
  const existing = active.get(projectKey);
  if (existing) return { ok: false, reason: 'already_active', active: existing };
  const build: ActiveBuild = { sessionId, projectKey, prompt, startedAt: Date.now() };
  active.set(projectKey, build);
  return { ok: true, build };
}

/**
 * Force-acquire for an INTENTIONAL restart (?force=1). Displaces any existing
 * owner and returns whatever it displaced so the caller can log the reason.
 */
export function forceAcquire(projectKey: string, sessionId: string, prompt: string): { build: ActiveBuild; displaced: ActiveBuild | null } {
  const displaced = active.get(projectKey) ?? null;
  const build: ActiveBuild = { sessionId, projectKey, prompt, startedAt: Date.now() };
  active.set(projectKey, build);
  return { build, displaced };
}

/** Release the lock. No-op unless the given session still owns it (avoids a
 *  late finalizer from a displaced build clearing a newer owner's lock). */
export function release(projectKey: string, sessionId: string): void {
  const cur = active.get(projectKey);
  if (cur && cur.sessionId === sessionId) active.delete(projectKey);
}

/** Test/diagnostic helper. */
export function _activeCount(): number {
  return active.size;
}
