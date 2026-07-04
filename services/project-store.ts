import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PROJECT_CONFIG } from '@/lib/constants';
import { GENERATED_ROOT } from '@/lib/workspace-paths';
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

const PROJECTS_DIR = GENERATED_ROOT;
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

/**
 * Scan the generated-projects directory for any project directories that are
 * NOT yet in the manifest and add them. This recovers projects whose manifest
 * entry was lost (e.g. build-safe.sh isolation, process crash, first-time setup).
 */
async function scanAndRepairManifest(ownerUserId: string): Promise<void> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const existing = await readManifest();
    const existingPaths = new Set(existing.map(p => p.projectPath));
    const toAdd: ProjectMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'gp-build-backup') continue;

      const projectPath = join(PROJECTS_DIR, entry.name);
      if (existingPaths.has(projectPath)) continue;

      // Detect project type and extract name
      let name = entry.name
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      let filesCount = 0;

      try {
        // Next.js project
        const pkgRaw = await readFile(join(projectPath, 'package.json'), 'utf-8');
        const pkg = JSON.parse(pkgRaw) as { name?: string };
        if (pkg.name) name = pkg.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } catch {
        try {
          // Flutter project
          const pubspec = await readFile(join(projectPath, 'pubspec.yaml'), 'utf-8');
          const match = pubspec.match(/^name:\s*(.+)/m);
          if (match) name = match[1].trim().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        } catch { /* not a known project type */ }
      }

      try {
        // Count files in project (quick estimate from lib/ or app/ or src/)
        for (const sub of ['app', 'lib', 'src', 'pages']) {
          try {
            const subEntries = await readdir(join(projectPath, sub));
            filesCount += subEntries.length;
          } catch { /* subdir doesn't exist */ }
        }
      } catch { /* ignore */ }

      // Get mtime for createdAt estimate
      let createdAt = new Date().toISOString();
      try {
        const s = await stat(projectPath);
        createdAt = s.birthtime.toISOString();
      } catch { /* use now */ }

      toAdd.push({
        id: `proj_${Date.now().toString(36)}_${entry.name.slice(0, 8)}`,
        ownerUserId,
        name,
        description: `Recovered from ${entry.name}`,
        projectPath,
        createdAt,
        updatedAt: createdAt,
        filesCount: Math.max(filesCount, 1),
      });
    }

    if (toAdd.length > 0) {
      const updated = [...existing, ...toAdd];
      await writeManifest(updated);
    }
  } catch { /* silent — scan is best-effort */ }
}

/** List projects owned by a specific user, most recent first. */
export async function listProjects(ownerUserId: string): Promise<ProjectMeta[]> {
  // Always scan disk first so projects created outside the normal flow still appear
  await scanAndRepairManifest(ownerUserId);

  const projects = await readManifest();
  return projects
    .filter(p => p.ownerUserId === ownerUserId || p.ownerUserId === 'anonymous')
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
