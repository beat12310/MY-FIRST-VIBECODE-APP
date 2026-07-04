import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveOpenProject, clearOpenProject, loadOpenProject, type PersistedProjectRef } from '../project-session-storage';

// Lightweight in-memory localStorage mock — the vitest environment for this
// suite is plain Node (no jsdom), so `window`/`localStorage` don't exist by
// default. This exercises the exact same getItem/setItem/removeItem calls
// the real module makes.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return [...this.store.keys()][index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, value); }
}

const sample: PersistedProjectRef = {
  id: 'proj_1', name: 'Football Predictor', description: 'A football prediction app',
  projectPath: '/tmp/generated-projects/football-predictor', port: 3001,
  createdAt: '2026-07-01T00:00:00.000Z', filesCount: 42,
};

describe('project-session-storage (fixes currentProject-lost-on-refresh)', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: Window }).window = { localStorage: new MemoryStorage() } as unknown as Window;
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: Window }).window;
  });

  it('returns null before anything has been saved', () => {
    expect(loadOpenProject()).toBeNull();
  });

  it('round-trips a saved project exactly', () => {
    saveOpenProject(sample);
    expect(loadOpenProject()).toEqual(sample);
  });

  it('clearOpenProject removes the persisted project', () => {
    saveOpenProject(sample);
    clearOpenProject();
    expect(loadOpenProject()).toBeNull();
  });

  it('returns null for corrupted/malformed stored JSON rather than throwing', () => {
    window.localStorage.setItem('dwomoh:lastOpenProject', '{not valid json');
    expect(() => loadOpenProject()).not.toThrow();
    expect(loadOpenProject()).toBeNull();
  });

  it('returns null for validly-parsed JSON missing required fields', () => {
    window.localStorage.setItem('dwomoh:lastOpenProject', JSON.stringify({ foo: 'bar' }));
    expect(loadOpenProject()).toBeNull();
  });

  it('does not throw when window/localStorage is unavailable (SSR-safe)', () => {
    delete (globalThis as unknown as { window?: Window }).window;
    expect(() => saveOpenProject(sample)).not.toThrow();
    expect(() => loadOpenProject()).not.toThrow();
    expect(() => clearOpenProject()).not.toThrow();
    expect(loadOpenProject()).toBeNull();
  });
});
