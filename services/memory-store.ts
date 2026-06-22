import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { PROJECT_CONFIG } from '@/lib/constants';
import { logError } from '@/lib/error-handler';

const PROJECTS_DIR = join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR);
const GLOBAL_MEMORY_PATH = join(PROJECTS_DIR, '.global-memory.json');
const PROJECT_MEMORY_FILE = '.project-memory.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GlobalMemory {
  version: number;
  updatedAt: string;
  userPreferences: {
    preferredStack?: string;
    preferredColors?: string;
    preferredLayout?: string;
    notes?: string;
  };
  successfulFixes: Array<{ problem: string; solution: string; projectName: string; date: string }>;
  failedAttempts: Array<{ request: string; error: string; projectName: string; date: string }>;
  reusableDecisions: Array<{ context: string; decision: string; reason?: string }>;
  buildHistory: Array<{ projectName: string; prompt: string; success: boolean; date: string }>;
  deploymentHistory: Array<{ projectName: string; url: string; platform: string; date: string }>;
}

export interface VerificationRecord {
  date: string;
  verified: boolean;
  summary: string;
  passedCount: number;
  totalCount: number;
}

export interface BrowserSessionRecord {
  date: string;
  pageTitle?: string;
  pageUrl?: string;
  errorCount: number;
  requestCount: number;
  screenshotUrl?: string;
}

export interface FileOpRecord {
  op: 'create' | 'delete' | 'rename' | 'move';
  path: string;
  newPath?: string;
  date: string;
}

export interface ProjectMemory {
  projectId: string;
  name: string;
  originalPrompt: string;
  purpose: string;
  createdAt: string;
  lastOpenedAt: string;
  projectPath: string;
  runningPort: number | null;
  previewUrl: string | null;
  buildStatus: 'success' | 'error' | 'unknown';
  framework: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  fileTree: string[];
  pages: string[];
  components: string[];
  libFiles: string[];
  serviceFiles: string[];
  stylingDecisions: string[];
  featuresBuilt: string[];
  bugsFixed: Array<{ bug: string; fix: string; date: string }>;
  editsApplied: Array<{ request: string; filesChanged: string[]; date: string }>;
  conversationHistory: Array<{ role: string; content: string; timestamp: string }>;
  lastDiscovery: {
    timestamp: string;
    summary: string;
    keyFiles: string[];
    framework: string;
  } | null;
  deploymentStatus: string | null;
  // New persistence fields
  authProvider?: string;
  dbIntegrations?: string[];
  deployConfigs?: string[];
  verificationHistory?: VerificationRecord[];
  browserSessions?: BrowserSessionRecord[];
  fileOperations?: FileOpRecord[];
}

// ─── Global Memory ────────────────────────────────────────────────────────────

const DEFAULT_GLOBAL: GlobalMemory = {
  version: 1,
  updatedAt: new Date().toISOString(),
  userPreferences: {},
  successfulFixes: [],
  failedAttempts: [],
  reusableDecisions: [],
  buildHistory: [],
  deploymentHistory: [],
};

export async function getGlobalMemory(): Promise<GlobalMemory> {
  try {
    const raw = await readFile(GLOBAL_MEMORY_PATH, 'utf-8');
    return JSON.parse(raw) as GlobalMemory;
  } catch {
    return { ...DEFAULT_GLOBAL, updatedAt: new Date().toISOString() };
  }
}

export async function saveGlobalMemory(memory: GlobalMemory): Promise<void> {
  try {
    await mkdir(PROJECTS_DIR, { recursive: true });
    memory.updatedAt = new Date().toISOString();
    await writeFile(GLOBAL_MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
  } catch (err) {
    logError('Failed to save global memory', err);
  }
}

export async function recordBuild(projectName: string, prompt: string, success: boolean): Promise<void> {
  const mem = await getGlobalMemory();
  mem.buildHistory = [...mem.buildHistory.slice(-49), {
    projectName, prompt: prompt.slice(0, 200), success, date: new Date().toISOString(),
  }];
  await saveGlobalMemory(mem);
}

export async function recordGlobalFix(problem: string, solution: string, projectName: string): Promise<void> {
  const mem = await getGlobalMemory();
  mem.successfulFixes = [...mem.successfulFixes.slice(-49), {
    problem, solution, projectName, date: new Date().toISOString(),
  }];
  await saveGlobalMemory(mem);
}

// ─── Project Memory ───────────────────────────────────────────────────────────

export function projectMemoryPath(projectPath: string): string {
  return join(projectPath, PROJECT_MEMORY_FILE);
}

export async function getProjectMemory(projectPath: string): Promise<ProjectMemory | null> {
  try {
    const raw = await readFile(projectMemoryPath(projectPath), 'utf-8');
    return JSON.parse(raw) as ProjectMemory;
  } catch {
    return null;
  }
}

export async function saveProjectMemory(projectPath: string, memory: ProjectMemory): Promise<void> {
  try {
    memory.lastOpenedAt = new Date().toISOString();
    await writeFile(projectMemoryPath(projectPath), JSON.stringify(memory, null, 2), 'utf-8');
  } catch (err) {
    logError('Failed to save project memory', err);
  }
}

export async function initProjectMemory(params: {
  projectId: string;
  name: string;
  originalPrompt: string;
  projectPath: string;
  purpose?: string;
}): Promise<ProjectMemory> {
  const memory: ProjectMemory = {
    projectId: params.projectId,
    name: params.name,
    originalPrompt: params.originalPrompt,
    purpose: params.purpose || params.originalPrompt,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    projectPath: params.projectPath,
    runningPort: null,
    previewUrl: null,
    buildStatus: 'unknown',
    framework: 'Next.js 15',
    dependencies: {},
    devDependencies: {},
    fileTree: [],
    pages: [],
    components: [],
    libFiles: [],
    serviceFiles: [],
    stylingDecisions: [],
    featuresBuilt: [],
    bugsFixed: [],
    editsApplied: [],
    conversationHistory: [],
    lastDiscovery: null,
    deploymentStatus: null,
  };
  await saveProjectMemory(params.projectPath, memory);
  return memory;
}

export async function updateProjectMemory(
  projectPath: string,
  updates: Partial<ProjectMemory>
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  await saveProjectMemory(projectPath, { ...mem, ...updates });
}

export async function appendConversationTurn(
  projectPath: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  const turn = { role, content: content.slice(0, 3000), timestamp: new Date().toISOString() };
  mem.conversationHistory = [...(mem.conversationHistory || []).slice(-40), turn];
  await saveProjectMemory(projectPath, mem);
}

export async function recordVerification(
  projectPath: string,
  result: { verified: boolean; summary: string; checks: Array<{ passed: boolean }> }
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  const record: VerificationRecord = {
    date: new Date().toISOString(),
    verified: result.verified,
    summary: result.summary,
    passedCount: result.checks.filter(c => c.passed).length,
    totalCount: result.checks.length,
  };
  mem.verificationHistory = [...(mem.verificationHistory || []).slice(-9), record];
  await saveProjectMemory(projectPath, mem);
}

export async function recordBrowserSession(
  projectPath: string,
  session: Omit<BrowserSessionRecord, 'date'>
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  const record: BrowserSessionRecord = { date: new Date().toISOString(), ...session };
  mem.browserSessions = [...(mem.browserSessions || []).slice(-4), record];
  await saveProjectMemory(projectPath, mem);
}

export async function recordScaffold(
  projectPath: string,
  type: 'auth' | 'db' | 'deploy',
  value: string
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  if (type === 'auth') {
    mem.authProvider = value;
  } else if (type === 'db') {
    const existing = mem.dbIntegrations || [];
    if (!existing.includes(value)) mem.dbIntegrations = [...existing, value];
  } else if (type === 'deploy') {
    const existing = mem.deployConfigs || [];
    if (!existing.includes(value)) mem.deployConfigs = [...existing, value];
  }
  await saveProjectMemory(projectPath, mem);
}

export async function recordFileOp(
  projectPath: string,
  op: FileOpRecord['op'],
  path: string,
  newPath?: string
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  const record: FileOpRecord = { op, path, newPath, date: new Date().toISOString() };
  mem.fileOperations = [...(mem.fileOperations || []).slice(-29), record];
  await saveProjectMemory(projectPath, mem);
}

export async function recordEditApplied(
  projectPath: string,
  request: string,
  filesChanged: string[]
): Promise<void> {
  const mem = await getProjectMemory(projectPath);
  if (!mem) return;
  mem.editsApplied = [...(mem.editsApplied || []).slice(-20), {
    request: request.slice(0, 300),
    filesChanged,
    date: new Date().toISOString(),
  }];
  await saveProjectMemory(projectPath, mem);
}
