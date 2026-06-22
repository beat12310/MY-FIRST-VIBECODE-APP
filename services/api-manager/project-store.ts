/**
 * Project API Config Store
 *
 * Persists which APIs each generated project uses, which provider was selected,
 * and whether it tested successfully. Stored in .dwomoh-api-manager.json at the
 * platform root. Never stores key values — only provider IDs and metadata.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export interface ProjectApiEntry {
  category: string;
  providerId: string;
  providerName: string;
  rapidApiHost?: string;
  status: 'working' | 'failed' | 'pending';
  testedAt?: string;
  errorMessage?: string;
}

export interface ProjectApiConfig {
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  apis: ProjectApiEntry[];
  /** Which platform port this project was built on */
  platformPort?: number;
}

type Store = Record<string, ProjectApiConfig>;

const STORE_PATH = join(process.cwd(), '.dwomoh-api-manager.json');

async function readStore(): Promise<Store> {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/** Save or update a project's API configuration. */
export async function saveProjectConfig(config: ProjectApiConfig): Promise<void> {
  const store = await readStore();
  store[config.projectId] = { ...config, updatedAt: new Date().toISOString() };
  await writeStore(store);
}

/** Retrieve a project's API configuration. Returns null if not found. */
export async function getProjectConfig(projectId: string): Promise<ProjectApiConfig | null> {
  const store = await readStore();
  return store[projectId] ?? null;
}

/** List all known project configs. */
export async function listProjectConfigs(): Promise<ProjectApiConfig[]> {
  const store = await readStore();
  return Object.values(store).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/** Update the status of a specific API entry within a project. */
export async function updateApiStatus(
  projectId: string,
  category: string,
  update: Partial<Pick<ProjectApiEntry, 'status' | 'testedAt' | 'errorMessage'>>,
): Promise<void> {
  const store = await readStore();
  const project = store[projectId];
  if (!project) return;
  const entry = project.apis.find(a => a.category === category);
  if (entry) Object.assign(entry, update, { testedAt: update.testedAt ?? new Date().toISOString() });
  project.updatedAt = new Date().toISOString();
  await writeStore(store);
}

/** Create a new project config with an empty APIs list. */
export async function initProjectConfig(
  projectId: string,
  projectPath: string,
  platformPort?: number,
): Promise<ProjectApiConfig> {
  const config: ProjectApiConfig = {
    projectId,
    projectPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    apis: [],
    platformPort,
  };
  await saveProjectConfig(config);
  return config;
}
