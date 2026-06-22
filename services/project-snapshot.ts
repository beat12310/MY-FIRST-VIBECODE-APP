/**
 * Project Snapshot — lightweight rollback for the autonomous agent loop.
 *
 * Before each AI-driven code fix, capture the content of the files that
 * will be touched. If the fix reduces the verification score, restore them
 * so the app returns to its last-known-good state before the next attempt.
 *
 * Storage: a single `.agent-snapshot.json` file in the project root.
 * Each entry: { "<relPath>": "<content>" | null }
 * null means the file did not exist before the fix (so restoration skips it).
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';

export interface SnapshotEntry {
  path: string;
  content: string | null;
}

const SNAPSHOT_FILENAME = '.agent-snapshot.json';

/** Capture current content of the given relative file paths, write to disk. */
export async function captureSnapshot(
  projectPath: string,
  relPaths: string[],
): Promise<void> {
  const entries: SnapshotEntry[] = [];
  for (const rel of relPaths) {
    try {
      const content = await readFile(join(projectPath, rel), 'utf-8');
      entries.push({ path: rel, content });
    } catch {
      entries.push({ path: rel, content: null }); // file did not exist
    }
  }
  await writeFile(
    join(projectPath, SNAPSHOT_FILENAME),
    JSON.stringify(entries, null, 2),
    'utf-8',
  );
}

/** Restore files from the last snapshot. Returns list of restored relative paths. */
export async function restoreSnapshot(projectPath: string): Promise<string[]> {
  const snapshotPath = join(projectPath, SNAPSHOT_FILENAME);
  let entries: SnapshotEntry[];
  try {
    entries = JSON.parse(await readFile(snapshotPath, 'utf-8'));
  } catch {
    return []; // no snapshot to restore
  }

  const restored: string[] = [];
  for (const { path: rel, content } of entries) {
    if (content === null) continue; // file didn't exist before — don't create it
    try {
      await writeFile(join(projectPath, rel), content, 'utf-8');
      restored.push(rel);
    } catch { /* non-critical */ }
  }

  await unlink(snapshotPath).catch(() => {});
  return restored;
}

/** Delete any pending snapshot without restoring (call on successful fix). */
export async function clearSnapshot(projectPath: string): Promise<void> {
  await unlink(join(projectPath, SNAPSHOT_FILENAME)).catch(() => {});
}

/** Read snapshot entries without restoring (for diagnostics). */
export async function readSnapshot(projectPath: string): Promise<SnapshotEntry[]> {
  try {
    return JSON.parse(
      await readFile(join(projectPath, SNAPSHOT_FILENAME), 'utf-8'),
    );
  } catch {
    return [];
  }
}
