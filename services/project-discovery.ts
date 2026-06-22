import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, extname } from 'path';
import { logError } from '@/lib/error-handler';
import { getProjectMemory, saveProjectMemory } from './memory-store';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'out', 'build', 'dist']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md']);
const MAX_READ = 40 * 1024; // 40KB per file for edit context
const MAX_CHAT_READ = 3 * 1024; // 3KB per file for chat context (shorter)

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscoveredFile {
  path: string;     // relative to project root
  absolute: string;
  ext: string;
  size: number;
}

export type ProjectMode = 'Static Demo' | 'Frontend Only' | 'Full-Stack App' | 'Production Ready App';

export interface MissingCredential {
  key: string;
  description: string;
}

export interface DiscoveryResult {
  projectPath: string;
  timestamp: string;
  framework: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  allFiles: DiscoveredFile[];
  pages: string[];
  components: string[];
  apiRoutes: string[];
  libFiles: string[];
  serviceFiles: string[];
  // Project mode detection
  mode: ProjectMode;
  hasApiRoutes: boolean;
  hasDatabase: boolean;
  hasAuth: boolean;
  hasDataFiles: boolean;
  // Credential management
  envExampleVars: string[];
  missingCredentials: MissingCredential[];
  // Full file contents for edit operations
  keyContents: Record<string, string>;
  // Summary string
  summary: string;
}

// ─── Directory scanner ────────────────────────────────────────────────────────

async function scanDir(dir: string, root: string, out: DiscoveredFile[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const name = e.name;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        await scanDir(full, root, out);
      } else if (e.isFile()) {
        const ext = extname(name);
        if (SOURCE_EXTS.has(ext) || name === 'package.json' || name === 'next.config.js' || name === 'tsconfig.json') {
          try {
            const s = await stat(full);
            out.push({ path: rel, absolute: full, ext, size: s.size });
          } catch { /* skip unreadable */ }
        }
      }
    }
  } catch (err) {
    logError(`scanDir failed: ${dir}`, err);
  }
}

async function safeRead(absPath: string, maxBytes = MAX_READ): Promise<string> {
  try {
    const raw = await readFile(absPath, 'utf-8');
    if (raw.length > maxBytes) return raw.slice(0, maxBytes) + '\n... [truncated]';
    return raw;
  } catch {
    return '';
  }
}

// ─── Main discovery ───────────────────────────────────────────────────────────

export async function discoverProject(projectPath: string): Promise<DiscoveryResult> {
  const allFiles: DiscoveredFile[] = [];
  await scanDir(projectPath, projectPath, allFiles);

  // Categorize
  const pages: string[] = [];
  const components: string[] = [];
  const apiRoutes: string[] = [];
  const libFiles: string[] = [];
  const serviceFiles: string[] = [];

  for (const f of allFiles) {
    const p = f.path;
    if (p.startsWith('app/') && (p.endsWith('/page.tsx') || p.endsWith('/page.ts') || p === 'app/page.tsx')) {
      pages.push(p);
    } else if (p.startsWith('app/api/') && (p.includes('/route.ts') || p.includes('/route.js'))) {
      apiRoutes.push(p);
    } else if (p.startsWith('components/') || p.startsWith('src/components/')) {
      components.push(p);
    } else if (p.startsWith('lib/') || p.startsWith('src/lib/')) {
      libFiles.push(p);
    } else if (p.startsWith('services/') || p.startsWith('src/services/')) {
      serviceFiles.push(p);
    }
  }

  // Read key file contents
  const keyContents: Record<string, string> = {};

  const alwaysRead = [
    'package.json',
    'app/page.tsx',
    'app/layout.tsx',
    ...pages.slice(0, 8),
    ...components.slice(0, 10),
    ...libFiles.slice(0, 5),
  ];

  for (const rel of Array.from(new Set(alwaysRead))) {
    const abs = join(projectPath, rel);
    if (existsSync(abs)) {
      keyContents[rel] = await safeRead(abs);
    }
  }

  // Parse package.json
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};
  let framework = 'Next.js';

  try {
    const pkg = JSON.parse(keyContents['package.json'] || '{}');
    dependencies = pkg.dependencies || {};
    devDependencies = pkg.devDependencies || {};
    const ver = dependencies['next']?.replace(/[\^~>=<]/, '').split('.')[0];
    if (ver) framework = `Next.js ${ver}`;
  } catch { /* skip */ }

  // ── Mode detection ─────────────────────────────────────────────────────────
  const hasApiRoutes = apiRoutes.length > 0;
  const DB_DEPS = ['@supabase/supabase-js', 'pg', '@prisma/client', 'prisma', 'firebase', 'dynamodb', 'mongoose'];
  const hasDatabase = DB_DEPS.some(d => dependencies[d] || devDependencies[d])
    || allFiles.some(f => /supabase|prisma|\.sql$/.test(f.path));
  const hasAuth = allFiles.some(f => /auth|middleware|session/.test(f.path));
  const hasDataFiles = allFiles.some(f => f.path.startsWith('lib/data/'));

  let mode: ProjectMode = 'Static Demo';
  if (hasDatabase && hasApiRoutes) mode = 'Production Ready App';
  else if (hasApiRoutes) mode = 'Full-Stack App';
  else if (components.length > 0 || pages.length > 1) mode = 'Frontend Only';

  // ── Credential detection from .env.local.example ──────────────────────────
  let envExampleVars: string[] = [];
  let missingCredentials: MissingCredential[] = [];

  const envExamplePath = join(projectPath, '.env.local.example');
  if (existsSync(envExamplePath)) {
    const exContent = await safeRead(envExamplePath);
    const lines = exContent.split('\n');

    // Parse comments + vars into {key, description} pairs
    let lastComment = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('#')) {
        lastComment = line.replace(/^#+\s*/, '');
        continue;
      }
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        if (key && !key.startsWith('#')) {
          envExampleVars.push(key);
          lastComment = '';
        }
      } else {
        lastComment = '';
      }
    }

    // Compare with .env.local to find missing values
    const envLocalPath = join(projectPath, '.env.local');
    let localContent = '';
    try { localContent = await safeRead(envLocalPath); } catch { /* no .env.local yet */ }

    const localVars: Record<string, string> = {};
    for (const line of localContent.split('\n')) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith('#')) continue;
      const eqIdx = stripped.indexOf('=');
      if (eqIdx > 0) {
        const k = stripped.slice(0, eqIdx).trim();
        const v = stripped.slice(eqIdx + 1).trim();
        localVars[k] = v;
      }
    }

    // Re-parse .env.local.example for descriptions
    lastComment = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('#')) { lastComment = line.replace(/^#+\s*/, ''); continue; }
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim().replace(/^#\s*/, '');
        const val = localVars[key];
        if (!val || val.startsWith('your_') || val === '') {
          missingCredentials.push({ key, description: lastComment || key });
        }
        lastComment = '';
      }
    }
  }

  // ── Summary string ─────────────────────────────────────────────────────────
  const pageLabels = pages.map(p => p.replace('app/', '').replace('/page.tsx', '').replace('/page.ts', '') || 'home');

  const summary = [
    `Mode: ${mode}`,
    `Framework: ${framework}`,
    `Pages (${pages.length}): ${pageLabels.join(', ') || 'home'}`,
    `Components (${components.length}): ${components.map(c => c.replace('components/', '').replace(/\.tsx?/, '')).join(', ') || 'none'}`,
    `API routes (${apiRoutes.length}): ${apiRoutes.join(', ') || 'none — search is client-side'}`,
    `Has sample data: ${hasDataFiles ? 'yes (lib/data/)' : 'no — data may be hardcoded in components'}`,
    `Database: ${hasDatabase ? 'yes' : 'no'}`,
    `Lib files: ${libFiles.map(l => l.replace('lib/', '').replace(/\.tsx?/, '')).join(', ') || 'none'}`,
    `Total source files: ${allFiles.length}`,
    `Dependencies: ${Object.keys(dependencies).filter(k => !['react', 'react-dom', 'next'].includes(k)).join(', ') || 'standard stack'}`,
    missingCredentials.length > 0 ? `Missing credentials: ${missingCredentials.map(c => c.key).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    projectPath,
    timestamp: new Date().toISOString(),
    framework,
    dependencies,
    devDependencies,
    allFiles,
    pages,
    components,
    apiRoutes,
    libFiles,
    serviceFiles,
    mode,
    hasApiRoutes,
    hasDatabase,
    hasAuth,
    hasDataFiles,
    envExampleVars,
    missingCredentials,
    keyContents,
    summary,
  };
}

// Run discovery and persist results into project memory
export async function discoverAndPersist(projectPath: string): Promise<DiscoveryResult> {
  const d = await discoverProject(projectPath);
  const mem = await getProjectMemory(projectPath);
  if (mem) {
    mem.framework = d.framework;
    mem.dependencies = d.dependencies;
    mem.devDependencies = d.devDependencies;
    mem.fileTree = d.allFiles.map(f => f.path);
    mem.pages = d.pages;
    mem.components = d.components;
    mem.libFiles = d.libFiles;
    mem.serviceFiles = d.serviceFiles;
    mem.lastDiscovery = {
      timestamp: d.timestamp,
      summary: d.summary,
      keyFiles: Object.keys(d.keyContents),
      framework: d.framework,
    };
    await saveProjectMemory(projectPath, mem);
  }
  return d;
}

// Build context string for CONVERSATION (shorter, to preserve chat tokens)
export function buildChatContext(
  discovery: DiscoveryResult,
  mem: { name: string; originalPrompt: string; purpose: string; editsApplied?: Array<{ request: string; filesChanged: string[]; date: string }>; conversationHistory?: Array<{ role: string; content: string }> } | null,
  port?: number | null
): string {
  const fileTree = discovery.allFiles.map(f => f.path).sort().join('\n');

  // Include key file contents (short version for chat)
  const chatFiles = ['app/page.tsx', 'app/layout.tsx', ...discovery.components.slice(0, 3)];
  const fileSnippets = chatFiles
    .filter(p => discovery.keyContents[p])
    .map(p => {
      const content = discovery.keyContents[p].slice(0, MAX_CHAT_READ);
      return `[FILE: ${p}]\n${content}${discovery.keyContents[p].length > MAX_CHAT_READ ? '\n... [truncated]' : ''}`;
    })
    .join('\n\n');

  const recentEdits = (mem?.editsApplied || []).slice(-3)
    .map(e => `• "${e.request}" → changed: ${e.filesChanged.join(', ')}`)
    .join('\n') || 'None yet';

  const recentConversation = (mem?.conversationHistory || []).slice(-4)
    .map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 400)}`)
    .join('\n\n');

  return `
=== CURRENTLY SELECTED PROJECT ===
Name: ${mem?.name || discovery.projectPath.split('/').pop()}
Purpose: ${mem?.purpose || mem?.originalPrompt || 'Unknown'}
Framework: ${discovery.framework}
Running on: ${port ? `http://localhost:${port}` : 'not started'}

FILE STRUCTURE:
${fileTree}

KEY FILE CONTENTS (current code):
${fileSnippets || '(no key files found)'}

RECENT EDITS APPLIED:
${recentEdits}

${recentConversation ? `RECENT CONVERSATION WITH THIS PROJECT:\n${recentConversation}` : ''}
=== END PROJECT CONTEXT ===`.trim();
}

// Build full context for EDIT operations (full file contents)
export async function buildEditContext(params: {
  discovery: DiscoveryResult;
  userRequest: string;
  mem: { name: string; originalPrompt: string; purpose: string; editsApplied?: Array<{ request: string; filesChanged: string[]; date: string }>; conversationHistory?: Array<{ role: string; content: string }> } | null;
  extraFiles?: string[];
}): Promise<string> {
  const { discovery, userRequest, mem, extraFiles = [] } = params;
  const req = userRequest.toLowerCase();

  // Determine which files are most relevant to edit
  const filesToInclude = new Set<string>();

  // Always include main page
  filesToInclude.add('app/page.tsx');

  // Include layout for header/footer/nav/global changes
  if (/header|footer|nav|layout|sign.in|sign-in|signin|top\s+right|top right/i.test(req)) {
    filesToInclude.add('app/layout.tsx');
  }

  // Match component names
  for (const comp of discovery.components) {
    const name = comp.replace('components/', '').replace(/\.tsx?/, '').toLowerCase();
    if (req.includes(name)) filesToInclude.add(comp);
  }

  // Match page names
  for (const page of discovery.pages) {
    const segment = page.split('/').slice(-2)[0]?.toLowerCase() || '';
    if (segment && req.includes(segment) && segment !== 'app') filesToInclude.add(page);
  }

  // Files explicitly mentioned in auto-detected error messages take priority
  for (const f of extraFiles) {
    const normalized = f.startsWith('./') ? f.slice(2) : f;
    filesToInclude.add(normalized);
  }

  // If still fewer than 3 files, add more
  if (filesToInclude.size < 3) {
    for (const path of Object.keys(discovery.keyContents)) {
      if (!filesToInclude.has(path) && path !== 'package.json') {
        filesToInclude.add(path);
        if (filesToInclude.size >= 5) break;
      }
    }
  }

  const fileTree = discovery.allFiles.map(f => f.path).sort().join('\n');

  // Build file content map — start with discovered keyContents
  const fileContentMap: Record<string, string> = { ...discovery.keyContents };

  // For extraFiles not in keyContents, read them directly from disk
  // (e.g. postcss.config.js, tailwind.config.js, next.config.js are often outside discovery scope)
  for (const f of extraFiles) {
    const normalized = f.startsWith('./') ? f.slice(2) : f;
    if (!fileContentMap[normalized] && discovery.projectPath) {
      try {
        const raw = await readFile(join(discovery.projectPath, normalized), 'utf-8');
        fileContentMap[normalized] = raw.slice(0, 8000);
      } catch { /* file not found — skip */ }
    }
  }

  const fileContentsStr = Array.from(filesToInclude)
    .filter(p => fileContentMap[p])
    .map(p => `[FILE: ${p}]\n${fileContentMap[p]}`)
    .join('\n\n--- NEXT FILE ---\n\n');

  const recentConversation = (mem?.conversationHistory || []).slice(-6)
    .map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 800)}`)
    .join('\n\n');

  const recentEdits = (mem?.editsApplied || []).slice(-3)
    .map(e => `• "${e.request}" changed: ${e.filesChanged.join(', ')}`)
    .join('\n') || 'None';

  return `PROJECT: ${mem?.name || 'Unknown'}
PURPOSE: ${mem?.purpose || mem?.originalPrompt || 'Unknown'}
FRAMEWORK: ${discovery.framework}

COMPLETE FILE TREE:
${fileTree}

FILES RELEVANT TO THIS REQUEST (current content):
${fileContentsStr}

RECENT EDITS:
${recentEdits}

${recentConversation ? `RECENT CONVERSATION:\n${recentConversation}\n` : ''}USER'S CURRENT REQUEST: ${userRequest}`;
}

// Returns the files most likely to need editing, with fresh content from disk
export async function getFilesForEdit(
  projectPath: string,
  userRequest: string,
  discovery: DiscoveryResult
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const req = userRequest.toLowerCase();

  // Decide which files to include
  const toRead = new Set<string>(['app/page.tsx']);

  if (/header|footer|nav|layout|sign.in|top\s+right/i.test(req)) toRead.add('app/layout.tsx');

  for (const comp of discovery.components) {
    const name = comp.replace('components/', '').replace(/\.tsx?/, '').toLowerCase();
    if (req.includes(name)) toRead.add(comp);
  }
  for (const page of discovery.pages) {
    const segment = page.split('/').slice(-2)[0]?.toLowerCase() || '';
    if (segment && req.includes(segment)) toRead.add(page);
  }

  if (toRead.size < 3) {
    for (const f of discovery.allFiles) {
      if (!toRead.has(f.path) && ['.tsx', '.ts'].includes(f.ext) && !f.path.includes('package')) {
        toRead.add(f.path);
        if (toRead.size >= 6) break;
      }
    }
  }

  for (const rel of Array.from(toRead)) {
    const abs = join(projectPath, rel);
    if (existsSync(abs)) {
      result[rel] = await safeRead(abs);
    }
  }

  return result;
}
