/**
 * Single source of truth for where generated projects live on disk.
 *
 * LOCALHOST (WORKSPACE_DIR unset):  <cwd>/generated-projects   ← unchanged, identical to today.
 * FARGATE WORKER (WORKSPACE_DIR set): the writable volume, e.g. /workspace.
 *
 * Lambda/Amplify never reaches this code for disk actions — those are proxied to
 * the worker (see app/api/chat proxy shim). This module only runs where the
 * filesystem is writable (localhost or the worker container).
 */
import { join } from 'path';
import { PROJECT_CONFIG } from './constants';

export const GENERATED_ROOT: string =
  process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim().length > 0
    ? process.env.WORKSPACE_DIR.trim()
    : join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR);

/** Absolute path for a single generated project by folder name. */
export function projectDir(projectName: string): string {
  return join(GENERATED_ROOT, projectName);
}
