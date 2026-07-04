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

// ── Live event broadcaster, per project ──────────────────────────────────
// ROOT CAUSE fix: this module's own original comment already anticipated
// "EventSource auto-reconnect after a proxy/heartbeat drop" as an expected
// scenario, but the route only ever rejected a reconnect with a terminal
// 'busy' event and closed the stream — there was no way for a reconnecting
// client to actually resume receiving progress from the still-running
// server-side pipeline. Confirmed live: a real build ran for ~14 minutes and
// completed successfully server-side (logged 200 status), but the client
// showed "Connection to the build engine was lost" partway through — the
// browser's EventSource had auto-reconnected (or the tab/network blipped),
// and the reconnect got a dead-end 'busy' response instead of rejoining the
// live stream. Fix: broadcast every event to ALL currently-attached
// subscribers for a project, and let a reconnecting request attach as an
// additional subscriber instead of being rejected, as long as the SAME
// build is still active.
type EventListener = (event: string, data: unknown) => void;
const subscribers = new Map<string, Set<EventListener>>();
// Small recent-event buffer so a reconnecting client isn't left with zero
// context between attaching and the next live event (e.g. it can show the
// last known stage immediately rather than a blank state).
const RECENT_EVENTS_KEPT = 5;
const recentEvents = new Map<string, { event: string; data: unknown }[]>();

/** Publish an event to every subscriber currently attached to this project's
 *  build (the original request's stream, plus any reconnected ones). */
export function publish(projectKey: string, event: string, data: unknown): void {
  const buf = recentEvents.get(projectKey) ?? [];
  buf.push({ event, data });
  while (buf.length > RECENT_EVENTS_KEPT) buf.shift();
  recentEvents.set(projectKey, buf);

  const subs = subscribers.get(projectKey);
  if (!subs) return;
  for (const listener of subs) {
    try { listener(event, data); } catch { /* one bad subscriber must not break others */ }
  }
}

/** Attach as a subscriber to a project's live build events. Returns an
 *  unsubscribe function. Immediately replays a few recent events so a
 *  reconnecting client has context before the next live event arrives. */
export function subscribe(projectKey: string, listener: EventListener): () => void {
  let subs = subscribers.get(projectKey);
  if (!subs) { subs = new Set(); subscribers.set(projectKey, subs); }
  subs.add(listener);
  for (const { event, data } of recentEvents.get(projectKey) ?? []) {
    try { listener(event, data); } catch { /* ignore replay failure */ }
  }
  return () => {
    subs?.delete(listener);
    if (subs && subs.size === 0) subscribers.delete(projectKey);
  };
}

function clearEventState(projectKey: string): void {
  subscribers.delete(projectKey);
  recentEvents.delete(projectKey);
}

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
  if (cur && cur.sessionId === sessionId) {
    active.delete(projectKey);
    clearEventState(projectKey);
  }
}

/** Test/diagnostic helper. */
export function _activeCount(): number {
  return active.size;
}
