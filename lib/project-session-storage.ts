/**
 * DWOMOH Vibe Code — persists which project is "currently open" across a
 * page refresh, using localStorage (survives reload, not just component
 * state).
 *
 * ROOT CAUSE this fixes: currentProject in app/builder/page.tsx was plain
 * `useState<ProjectMeta|null>`, set only by explicit user actions (opening a
 * project from the sidebar, or a build completing) and never restored on
 * mount — a developer comment in that file explicitly flagged this exact
 * risk before it was fixed: "a null value here (e.g. after a page refresh,
 * with no restoration mechanism) means the ENTIRE 'project open → edit'
 * branch never runs, regardless of any fix inside it." Confirmed live: the
 * mount-time effect unconditionally showed the cold-start goal picker on
 * every fresh page load, with no check for a project that was already open
 * before the refresh — so a repair request sent right after a refresh had
 * no open project to route against, no matter how well decideProjectOpenRouting
 * (lib/repair-routing.ts) classified the message.
 *
 * Pure read/write helpers only — the actual restore (re-discovering the
 * project, restarting its dev server, replaying memory/history) stays in
 * page.tsx's handleOpenProject, which already does all of that correctly
 * for the "user clicks a project in the sidebar" case. This module is only
 * responsible for remembering WHICH project that was.
 */

const STORAGE_KEY = 'dwomoh:lastOpenProject';

export interface PersistedProjectRef {
  id: string;
  name: string;
  description: string;
  projectPath: string;
  port?: number;
  createdAt: string;
  filesCount: number;
}

/** Safe on the server (SSR) and in any environment without localStorage. */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveOpenProject(project: PersistedProjectRef): void {
  const storage = getStorage();
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(project)); } catch { /* quota/private-mode — non-fatal */ }
}

export function clearOpenProject(): void {
  const storage = getStorage();
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch { /* non-fatal */ }
}

/** Returns null on first load, private-mode storage failures, or corrupted/malformed data — never throws. */
export function loadOpenProject(): PersistedProjectRef | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.projectPath !== 'string' || typeof parsed.name !== 'string') return null;
    return parsed as PersistedProjectRef;
  } catch {
    return null;
  }
}
