import { describe, it, expect, beforeEach } from 'vitest';
import { publish, subscribe, tryAcquire, forceAcquire, release, getActiveBuild, projectKeyFromPrompt, newSessionId, _activeCount } from '../build-registry';

// This module holds in-process singleton state (the `active` Map and
// `subscribers` Map are module-level, not reset between tests automatically).
// Each test uses its own unique project key (derived from a unique prompt) to
// avoid cross-test interference — a fresh describe-level counter keeps keys
// unique without needing a module reset hook.
let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return projectKeyFromPrompt(`test project ${keyCounter} ${Date.now()}`);
}

describe('build-registry — single-flight lock', () => {
  it('tryAcquire succeeds when no build is active for the project', () => {
    const key = freshKey();
    const result = tryAcquire(key, newSessionId(), 'test prompt');
    expect(result.ok).toBe(true);
  });

  it('tryAcquire fails when a build is already active for the project', () => {
    const key = freshKey();
    const session1 = newSessionId();
    tryAcquire(key, session1, 'test prompt');
    const result = tryAcquire(key, newSessionId(), 'test prompt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.active.sessionId).toBe(session1);
  });

  it('release() by the owning session frees the lock for a new acquire', () => {
    const key = freshKey();
    const session1 = newSessionId();
    tryAcquire(key, session1, 'test prompt');
    release(key, session1);
    expect(getActiveBuild(key)).toBeNull();
    expect(tryAcquire(key, newSessionId(), 'test prompt').ok).toBe(true);
  });

  it('release() by a NON-owning session is a no-op (prevents a displaced build\'s late finalizer from clearing a newer owner\'s lock)', () => {
    const key = freshKey();
    const session1 = newSessionId();
    tryAcquire(key, session1, 'test prompt');
    release(key, 'some-other-session-id');
    expect(getActiveBuild(key)?.sessionId).toBe(session1);
  });

  it('forceAcquire displaces an existing owner and reports what it displaced', () => {
    const key = freshKey();
    const session1 = newSessionId();
    tryAcquire(key, session1, 'test prompt');
    const session2 = newSessionId();
    const { build, displaced } = forceAcquire(key, session2, 'test prompt');
    expect(build.sessionId).toBe(session2);
    expect(displaced?.sessionId).toBe(session1);
    expect(getActiveBuild(key)?.sessionId).toBe(session2);
  });
});

describe('build-registry — pub/sub resilience (fixed 2026-06)', () => {
  // ROOT CAUSE: a reconnecting EventSource (after a proxy/heartbeat drop,
  // browser refresh, or duplicate tab) got a dead-end 'busy' rejection
  // instead of rejoining the live stream of an already-running build.
  // Confirmed live: a real build ran ~14 minutes and completed successfully
  // server-side, but the client showed "Connection to the build engine was
  // lost" partway through because the reconnect had no way to resume.
  it('broadcasts a published event to a subscriber attached before the publish', () => {
    const key = freshKey();
    const received: { event: string; data: unknown }[] = [];
    const unsubscribe = subscribe(key, (event, data) => received.push({ event, data }));
    publish(key, 'progress', { stage: 'planning' });
    expect(received).toEqual([{ event: 'progress', data: { stage: 'planning' } }]);
    unsubscribe();
  });

  it('broadcasts to MULTIPLE subscribers on the same project (the original stream + a reconnected one)', () => {
    const key = freshKey();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const unsubA = subscribe(key, (event) => receivedA.push(event));
    const unsubB = subscribe(key, (event) => receivedB.push(event));
    publish(key, 'progress', {});
    expect(receivedA).toEqual(['progress']);
    expect(receivedB).toEqual(['progress']);
    unsubA(); unsubB();
  });

  it('replays recent events to a subscriber that attaches AFTER events were already published (the reconnect case)', () => {
    const key = freshKey();
    publish(key, 'progress', { stage: 'planning' });
    publish(key, 'progress', { stage: 'generating' });
    const received: unknown[] = [];
    subscribe(key, (event, data) => received.push(data));
    // The reconnecting subscriber should immediately see the recent events
    // replayed, not just future ones — this is what gives it context instead
    // of a blank state.
    expect(received).toEqual([{ stage: 'planning' }, { stage: 'generating' }]);
  });

  it('one throwing subscriber does not prevent other subscribers from receiving the event', () => {
    const key = freshKey();
    const received: string[] = [];
    subscribe(key, () => { throw new Error('simulated bad listener'); });
    subscribe(key, (event) => received.push(event));
    expect(() => publish(key, 'progress', {})).not.toThrow();
    expect(received).toEqual(['progress']);
  });

  it('unsubscribe() stops further events from reaching that listener', () => {
    const key = freshKey();
    const received: string[] = [];
    const unsubscribe = subscribe(key, (event) => received.push(event));
    unsubscribe();
    publish(key, 'progress', {});
    expect(received).toEqual([]);
  });

  it('release() clears event/subscriber state for the project (no stale replay into a future, unrelated build on the same key)', () => {
    const key = freshKey();
    const session1 = newSessionId();
    tryAcquire(key, session1, 'test prompt');
    publish(key, 'progress', { stage: 'old-build' });
    release(key, session1);

    const received: unknown[] = [];
    subscribe(key, (event, data) => received.push(data));
    expect(received).toEqual([]);
  });
});

describe('build-registry — projectKeyFromPrompt', () => {
  it('produces the same key for the same prompt', () => {
    expect(projectKeyFromPrompt('Build a football prediction app')).toBe(projectKeyFromPrompt('Build a football prediction app'));
  });

  it('normalizes case and punctuation so near-identical prompts collide correctly', () => {
    expect(projectKeyFromPrompt('Build A Football App!')).toBe(projectKeyFromPrompt('build a football app'));
  });
});
