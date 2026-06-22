import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { PROJECT_CONFIG } from '@/lib/constants';
import { logError } from '@/lib/error-handler';

export interface ProjectMeta {
  id: string;
  /** Cognito user sub — every project must be owned by exactly one user */
  ownerUserId: string;
  name: string;
  description: string;
  projectPath: string;
  port?: number;
  createdAt: string;
  updatedAt: string;
  filesCount: number;
}

const PROJECTS_DIR = join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR);
const MANIFEST_PATH = join(PROJECTS_DIR, '.projects.json');

async function readManifest(): Promise<ProjectMeta[]> {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw) as ProjectMeta[];
  } catch {
    return [];
  }
}

async function writeManifest(projects: ProjectMeta[]): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(projects, null, 2), 'utf-8');
}

/** List projects owned by a specific user, most recent first. */
export async function listProjects(ownerUserId: string): Promise<ProjectMeta[]> {
  const projects = await readManifest();
  return projects
    .filter(p => p.ownerUserId === ownerUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveProject(meta: Omit<ProjectMeta, 'id'>): Promise<ProjectMeta> {
  try {
    const projects = await readManifest();
    const existingIdx = projects.findIndex(p => p.projectPath === meta.projectPath);
    const id = existingIdx >= 0 ? projects[existingIdx].id : `proj_${Date.now().toString(36)}`;
    const project: ProjectMeta = { ...meta, id };

    if (existingIdx >= 0) {
      projects[existingIdx] = project;
    } else {
      projects.push(project);
    }

    await writeManifest(projects);
    return project;
  } catch (err) {
    logError('Failed to save project to manifest', err);
    return { ...meta, id: `proj_${Date.now().toString(36)}` };
  }
}

export async function updateProjectPort(projectPath: string, port: number): Promise<void> {
  try {
    const projects = await readManifest();
    const idx = projects.findIndex(p => p.projectPath === projectPath);
    if (idx >= 0) {
      projects[idx].port = port;
      projects[idx].updatedAt = new Date().toISOString();
      await writeManifest(projects);
    }
  } catch (err) {
    logError('Failed to update project port', err);
  }
}

/**
 * Get a project by ID.
 * Optionally pass ownerUserId to enforce ownership — returns null if the project
 * exists but belongs to a different user.
 */
export async function getProject(id: string, ownerUserId?: string): Promise<ProjectMeta | null> {
  const projects = await readManifest();
  const project = projects.find(p => p.id === id) ?? null;
  if (!project) return null;
  if (ownerUserId && project.ownerUserId !== ownerUserId) return null;
  return project;
}
