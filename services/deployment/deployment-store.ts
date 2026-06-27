/**
 * Deployment Record Store
 *
 * Persists deployment records to generated-projects/.deployments.json
 * One record per project, updated in place as status changes.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { DeploymentRecord } from './types';

const STORE_PATH = join(process.cwd(), 'generated-projects', '.deployments.json');

interface DeploymentStore {
  version: number;
  updatedAt: string;
  /** keyed by projectId */
  deployments: Record<string, DeploymentRecord>;
}

const DEFAULT_STORE: DeploymentStore = {
  version: 1,
  updatedAt: new Date().toISOString(),
  deployments: {},
};

async function readStore(): Promise<DeploymentStore> {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw) as DeploymentStore;
  } catch {
    return { ...DEFAULT_STORE, updatedAt: new Date().toISOString() };
  }
}

async function writeStore(store: DeploymentStore): Promise<void> {
  store.updatedAt = new Date().toISOString();
  await mkdir(join(process.cwd(), 'generated-projects'), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export async function saveDeploymentRecord(record: DeploymentRecord): Promise<void> {
  const store = await readStore();
  store.deployments[record.projectId] = record;
  await writeStore(store);
}

export async function getDeploymentRecord(projectId: string): Promise<DeploymentRecord | null> {
  const store = await readStore();
  return store.deployments[projectId] ?? null;
}

export async function listDeploymentRecords(): Promise<DeploymentRecord[]> {
  const store = await readStore();
  return Object.values(store.deployments).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export async function updateDeploymentStatus(
  projectId: string,
  update: Partial<Pick<DeploymentRecord,
    'status' | 'statusDetail' | 'completedAt' | 'errorMessage' | 'customDomains' | 'verificationResult'
  >>
): Promise<DeploymentRecord | null> {
  const store = await readStore();
  const record = store.deployments[projectId];
  if (!record) return null;
  Object.assign(record, update);
  await writeStore(store);
  return record;
}

export async function deleteDeploymentRecord(projectId: string): Promise<void> {
  const store = await readStore();
  delete store.deployments[projectId];
  await writeStore(store);
}
