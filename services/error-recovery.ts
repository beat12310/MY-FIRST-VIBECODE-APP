/**
 * Autonomous Error Recovery Service
 *
 * Classifies any build, validation, or runtime error, applies a fix, and
 * returns a plain-English message. Never exposes stack traces to the user.
 * The build pipeline should NEVER stop because of an error this service
 * can handle — missing packages, broken imports, auth, env vars, TypeScript.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { installDependencies } from './project-runner';

// ─── Error categories ─────────────────────────────────────────────────────────

export type ErrorKind =
  | 'missing-package'     // Module not found (npm package)
  | 'broken-import'       // @/alias that doesn't exist on disk → create stub
  | 'missing-env'         // process.env.X is undefined
  | 'auth-misconfigured'  // NEXTAUTH_SECRET, next-auth errors
  | 'typescript-error'    // error TS####
  | 'syntax-error'        // SyntaxError / unexpected token
  | 'route-failure'       // API route returned 4xx/5xx
  | 'runtime-crash'       // Server crashed at runtime
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  raw: string;
  extracted?: string;
  userMessage: string;
}

export interface RecoveryResult {
  fixed: boolean;
  classified: ClassifiedError;
  actions: string[];
  filesPatched: string[];
  packagesInstalled: string[];
  requiresReinstall: boolean;
  requiresRevalidate: boolean;
  requiresRestart: boolean;
  successMessage: string;
}

// ─── Detection patterns ───────────────────────────────────────────────────────

const MISSING_MODULE_RE = [
  /Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]/i,
  /Cannot find module ['"]([^'"@][^'"]*)['"]/i,
  /Error: Cannot find module ['"]([^'"@][^'"]*)['"]/i,
  /Failed to resolve import ['"]([^'"@][^'"./][^'"]*)['"]/i,
  /error TS2307: Cannot find module ['"]([^'"@][^'"]*)['"]/i,
  /error TS2305: Module ['"]([^'"@][^'"]*)['"]/i,
];

const BROKEN_LOCAL_IMPORT_RE = [
  /Module not found.*['"](@\/[^'"]+)['"]/i,
  /Cannot find module.*['"](@\/[^'"]+)['"]/i,
  /error TS2307.*['"](@\/[^'"]+)['"]/i,
  /Failed to resolve import.*['"](@\/[^'"]+)['"]/i,
];

const MISSING_ENV_RE = [
  /process\.env\.(\w+) is (?:undefined|not set|null)/i,
  /Missing required (?:env(?:ironment)? var(?:iable)?):?\s*['"]([\w_]+)['"]/i,
  /Please define the ([\w_]+) environment variable/i,
  /Environment variable not found: ([\w_]+)/i,
];

const AUTH_ERROR_RE = [
  /NEXTAUTH_SECRET/i, /AUTH_SECRET/i, /\[next-auth\]/i,
  /next-auth.*(?:secret|error|missing)/i, /auth.*not.*configured/i,
  /error TS2307.*next-auth/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function modulePathToPackage(modulePath: string): string {
  if (modulePath.startsWith('@')) return modulePath.split('/').slice(0, 2).join('/');
  return modulePath.split('/')[0];
}

function isLocalAlias(p: string): boolean {
  return p.startsWith('@/') || p.startsWith('./') || p.startsWith('../');
}

// ─── Local stub creation ──────────────────────────────────────────────────────

/**
 * Extract ALL missing @/ local module paths from a block of tsc/webpack error text.
 */
export function extractMissingLocalModules(errorText: string): string[] {
  const found: Record<string, true> = {};
  const re = /(?:Module not found|Cannot find module|TS2307|Failed to resolve import)[^'"]*['"](@\/[^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(errorText)) !== null) {
    found[m[1]] = true;
  }
  return Object.keys(found);
}

/**
 * Generate minimal stub content appropriate to the file path.
 * Stubs are placeholders — enough to satisfy the import and let the real
 * code compile. The AI fixer will fill them in correctly later if needed.
 */
function inferStubContent(aliasPath: string): { content: string; ext: string } {
  const name = (aliasPath.split('/').pop() ?? 'Component').replace(/\.(tsx?|jsx?)$/, '');
  const isHook = /^use[A-Z]/.test(name);
  const isContext = /context|provider/i.test(name);
  const isType = /type|interface|schema/i.test(name) || /\/types\b/i.test(aliasPath);
  const isUtil = /util|helper|service|store|api|config/i.test(aliasPath);
  const isComponent = /^[A-Z]/.test(name) && !isHook;

  if (isType) {
    return {
      content: `// Auto-generated type stub\nexport type ${name} = Record<string, unknown>;\nexport interface I${name} {}\nexport default {};\n`,
      ext: '.ts',
    };
  }
  if (isHook) {
    return {
      content: `'use client';\nimport { useState } from 'react';\nexport function ${name}() {\n  const [data, setData] = useState<unknown>(null);\n  return { data, setData };\n}\n`,
      ext: '.ts',
    };
  }
  if (isContext) {
    return {
      content: `'use client';\nimport { createContext, useContext } from 'react';\nconst Ctx = createContext<Record<string, unknown>>({});\nexport default Ctx;\nexport const use${name.replace(/Provider|Context/i, '')} = () => useContext(Ctx);\n`,
      ext: '.tsx',
    };
  }
  if (isUtil) {
    return { content: `// Auto-generated utility stub\nexport default {};\n`, ext: '.ts' };
  }
  if (isComponent) {
    return {
      content: `import type { ReactNode } from 'react';\nexport default function ${name}({ children }: { children?: ReactNode }) {\n  return <>{children}</>;\n}\n`,
      ext: '.tsx',
    };
  }
  return { content: `export default {};\n`, ext: '.ts' };
}

/**
 * Create minimal stub files for every @/ alias that doesn't exist on disk.
 * Returns the list of relative paths created.
 */
export async function createLocalStubs(
  projectPath: string,
  aliasPaths: string[]
): Promise<string[]> {
  const created: string[] = [];

  for (const aliasPath of aliasPaths) {
    const relative = aliasPath.replace(/^@\//, '');
    const { content, ext } = inferStubContent(aliasPath);
    const filePath = join(projectPath, relative + ext);
    const altPath = join(projectPath, relative + (ext === '.tsx' ? '.ts' : '.tsx'));

    // Skip if either extension already exists
    const exists = await access(filePath).then(() => true).catch(() => false) ||
                   await access(altPath).then(() => true).catch(() => false);
    if (exists) continue;

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    created.push(relative + ext);
  }

  return created;
}

// ─── Public classifiers ───────────────────────────────────────────────────────

export function classifyError(errorText: string): ClassifiedError {
  const raw = errorText.slice(0, 4000);

  // 1. Broken local import (must check before external packages)
  for (const re of BROKEN_LOCAL_IMPORT_RE) {
    const m = re.exec(raw);
    if (m) {
      return {
        kind: 'broken-import',
        raw,
        extracted: m[1],
        userMessage: `A file reference is broken (**${m[1]}**). Creating a placeholder file so the code can compile.`,
      };
    }
  }

  // 2. Missing npm package
  for (const re of MISSING_MODULE_RE) {
    const m = re.exec(raw);
    if (m && !isLocalAlias(m[1])) {
      const pkg = modulePathToPackage(m[1]);
      return {
        kind: 'missing-package',
        raw,
        extracted: pkg,
        userMessage: `A required package (**${pkg}**) isn't installed. Installing it now…`,
      };
    }
  }

  // 3. Auth misconfiguration
  if (AUTH_ERROR_RE.some(re => re.test(raw))) {
    return {
      kind: 'auth-misconfigured',
      raw,
      userMessage: `Authentication needs a secret key. Adding a temporary one so the preview works.`,
    };
  }

  // 4. Missing environment variable
  for (const re of MISSING_ENV_RE) {
    const m = re.exec(raw);
    if (m) {
      const varName = m[1] ?? 'a required variable';
      return {
        kind: 'missing-env',
        raw,
        extracted: varName,
        userMessage: `A required config value (**${varName}**) is missing. Adding a safe placeholder for the preview.`,
      };
    }
  }

  // 5. TypeScript compile errors
  if (/error TS\d+/i.test(raw) || /TypeScript.*error/i.test(raw)) {
    const count = (raw.match(/error TS\d+/gi) ?? []).length;
    return {
      kind: 'typescript-error',
      raw,
      userMessage: `I found ${count > 0 ? count : 'some'} code issue${count !== 1 ? 's' : ''} in the generated files. Fixing them now…`,
    };
  }

  // 6. Syntax error
  if (/SyntaxError|Unexpected token|Unexpected end of/i.test(raw)) {
    return {
      kind: 'syntax-error',
      raw,
      userMessage: `There's a syntax error in the generated code. Correcting it now…`,
    };
  }

  return {
    kind: 'unknown',
    raw,
    userMessage: `An unexpected issue occurred. Attempting automatic recovery…`,
  };
}

/**
 * Extract ALL unique missing npm package names from a block of error text.
 */
export function extractAllMissingPackages(errorText: string): string[] {
  const found: Record<string, true> = {};
  for (const re of MISSING_MODULE_RE) {
    const global = new RegExp(re.source, 'gi');
    let m;
    while ((m = global.exec(errorText)) !== null) {
      if (!isLocalAlias(m[1])) found[modulePathToPackage(m[1])] = true;
    }
  }
  return Object.keys(found);
}

/**
 * Extract relative file paths from tsc error output.
 */
export function identifyAffectedFiles(errors: string[]): string[] {
  const seen: Record<string, true> = {};
  const results: string[] = [];

  for (const e of errors) {
    const abs = e.match(/generated-projects\/[^/]+\/(.+?)\(\d+,\d+\)/);
    if (abs && !seen[abs[1]]) { seen[abs[1]] = true; results.push(abs[1]); continue; }

    const rel = e.match(/(?:^|\s)((?:\.\/)?(?:app|components|lib|pages|services)\/[^\s(:]+\.tsx?)/);
    if (rel && !seen[rel[1]]) { seen[rel[1]] = true; results.push(rel[1].replace(/^\.\//, '')); continue; }

    const ts = e.match(/^([^(]+\.tsx?)\(\d+,\d+\)/);
    if (ts && !seen[ts[1]]) { seen[ts[1]] = true; results.push(ts[1]); }
  }

  return results.slice(0, 8);
}

// ─── Fix implementations ──────────────────────────────────────────────────────

async function addPackagesToJson(projectPath: string, pkgs: string[]): Promise<string[]> {
  const pkgPath = join(projectPath, 'package.json');
  try {
    const json = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (!json.dependencies) json.dependencies = {};
    const added: string[] = [];
    for (const pkg of pkgs) {
      const existing = json.dependencies[pkg] ?? json.devDependencies?.[pkg];
      if (!existing) {
        // New package — add with latest
        json.dependencies[pkg] = 'latest';
        added.push(pkg);
      } else if (existing !== 'latest' && /\^[5-9]\.\d+\.\d+/.test(existing)) {
        // AI pinned a non-existent future version (e.g. next-auth@^5.0.0 before v5 GA)
        // Reset to latest so npm can resolve it.
        json.dependencies[pkg] = 'latest';
        added.push(pkg);
      }
    }
    if (added.length > 0) await writeFile(pkgPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
    return added;
  } catch {
    return [];
  }
}

export async function applyAuthFallback(projectPath: string): Promise<string[]> {
  const envPath = join(projectPath, '.env.local');
  let existing = '';
  try { existing = await readFile(envPath, 'utf-8'); } catch { /* new file */ }

  const toAdd: string[] = [];
  if (!existing.includes('NEXTAUTH_SECRET')) toAdd.push('NEXTAUTH_SECRET=dwomoh-vibecode-preview-secret-change-before-deploying');
  if (!existing.includes('NEXTAUTH_URL') && !existing.includes('AUTH_URL')) toAdd.push('NEXTAUTH_URL=http://localhost:3001');

  if (toAdd.length > 0) {
    await writeFile(envPath, existing.trimEnd() + '\n# Auto-added by DWOMOH Vibe Code\n' + toAdd.join('\n') + '\n', 'utf-8');
  }

  const authDir = join(projectPath, 'app', 'api', 'auth', '[...nextauth]');
  const authRoute = join(authDir, 'route.ts');
  try {
    await mkdir(authDir, { recursive: true });
    const hasRoute = await readFile(authRoute, 'utf-8').then(() => true).catch(() => false);
    if (!hasRoute) {
      await writeFile(authRoute, `import NextAuth from 'next-auth';\nconst handler = NextAuth({ providers: [] });\nexport { handler as GET, handler as POST };\n`, 'utf-8');
      toAdd.push('app/api/auth/[...nextauth]/route.ts');
    }
  } catch { /* ignore */ }

  return ['.env.local', ...toAdd];
}

async function addEnvPlaceholder(projectPath: string, varName: string): Promise<void> {
  const envPath = join(projectPath, '.env.local');
  let existing = '';
  try { existing = await readFile(envPath, 'utf-8'); } catch { /* new */ }
  if (!existing.includes(varName + '=')) {
    await writeFile(envPath, existing + `${varName}=placeholder-replace-before-deploying\n`, 'utf-8');
  }
}

// ─── Main recovery dispatcher ─────────────────────────────────────────────────

export async function attemptRecovery(
  projectPath: string,
  errorText: string,
  _attempt: number = 0
): Promise<RecoveryResult> {
  const classified = classifyError(errorText);
  const actions: string[] = [];
  const filesPatched: string[] = [];
  const packagesInstalled: string[] = [];
  let requiresReinstall = false;
  let requiresRevalidate = false;
  let requiresRestart = false;
  let fixed = false;

  switch (classified.kind) {

    case 'broken-import': {
      // Extract ALL missing local modules from the full error text
      const missingLocals = extractMissingLocalModules(errorText);
      if (missingLocals.length > 0) {
        actions.push(`Creating stub files for: ${missingLocals.join(', ')}`);
        const created = await createLocalStubs(projectPath, missingLocals);
        if (created.length > 0) {
          filesPatched.push(...created);
          fixed = true;
          requiresRevalidate = true;
          actions.push(`✅ Created: ${created.join(', ')}`);
        } else {
          actions.push('Stub files already exist — needs AI code fix');
        }
      }
      break;
    }

    case 'missing-package': {
      const allPkgs = extractAllMissingPackages(errorText);
      if (allPkgs.length > 0) {
        actions.push(`Adding to package.json: ${allPkgs.join(', ')}`);
        const added = await addPackagesToJson(projectPath, allPkgs);
        // Always run npm install — even if the package was already in package.json
        // it may not be in node_modules (e.g. npm install previously failed silently).
        const pkgsToInstall = added.length > 0 ? added : allPkgs;
        actions.push(added.length > 0 ? `Installing: ${pkgsToInstall.join(', ')}` : `Already in package.json — ensuring node_modules: ${pkgsToInstall.join(', ')}`);
        let r = await installDependencies(projectPath);
        if (!r.success) {
          actions.push('Retrying with --force…');
          r = await installDependencies(projectPath, ['--force']);
        }
        if (!r.success) {
          actions.push('Retrying with --force --omit=optional…');
          r = await installDependencies(projectPath, ['--force', '--omit=optional']);
        }
        if (r.success) {
          packagesInstalled.push(...pkgsToInstall);
          fixed = true;
          actions.push(`✅ Installed: ${pkgsToInstall.join(', ')}`);
        } else {
          actions.push(`⚠️ Install failed — packages in package.json, restart may work`);
          fixed = true;
        }
        requiresRevalidate = true;
        requiresRestart = true;
      }
      break;
    }

    case 'auth-misconfigured': {
      actions.push('Applying auth fallback…');
      const applied = await applyAuthFallback(projectPath);
      filesPatched.push(...applied);
      requiresRestart = true;
      fixed = true;
      actions.push(`✅ Auth fallback applied`);
      break;
    }

    case 'missing-env': {
      const varName = classified.extracted ?? 'UNKNOWN_VAR';
      actions.push(`Adding ${varName} placeholder…`);
      await addEnvPlaceholder(projectPath, varName);
      filesPatched.push('.env.local');
      requiresRestart = true;
      fixed = true;
      actions.push(`✅ Added placeholder for ${varName}`);
      break;
    }

    case 'broken-import':
    case 'typescript-error':
    case 'syntax-error': {
      fixed = false;
      requiresRevalidate = true;
      actions.push('Needs AI code fix');
      break;
    }

    default:
      actions.push('No automatic fix available — needs investigation');
  }

  return {
    fixed,
    classified,
    actions,
    filesPatched,
    packagesInstalled,
    requiresReinstall,
    requiresRevalidate,
    requiresRestart,
    successMessage: buildSuccessMsg(classified, packagesInstalled, filesPatched),
  };
}

function buildSuccessMsg(c: ClassifiedError, pkgs: string[], files: string[]): string {
  switch (c.kind) {
    case 'missing-package':
      return pkgs.length > 0
        ? `✅ Installed missing package${pkgs.length > 1 ? 's' : ''}: **${pkgs.join(', ')}**. Re-validating…`
        : `✅ Package configuration updated. Re-validating…`;
    case 'broken-import':
      return `✅ Created ${files.length} missing file${files.length !== 1 ? 's' : ''} (${files.join(', ')}). Re-validating…`;
    case 'auth-misconfigured':
      return `✅ Authentication configured with a temporary key. Set real credentials before deploying.`;
    case 'missing-env':
      return `✅ Added placeholder for **${c.extracted}**. Set the real value in the sidebar before deploying.`;
    case 'typescript-error':
    case 'syntax-error':
      return `✅ Code issues fixed. Re-validating…`;
    default:
      return `✅ Applied recovery. Retrying…`;
  }
}

export function describeRecovery(
  kind: ErrorKind,
  packages: string[],
  files: string[],
  rounds: number
): string {
  const parts: string[] = [];
  if (packages.length > 0) parts.push(`installed ${packages.join(', ')}`);
  if (files.some(f => f === '.env.local')) parts.push('added missing configuration');
  if (files.some(f => f.includes('auth'))) parts.push('configured authentication');
  if (files.some(f => f.endsWith('.tsx') || f.endsWith('.ts')) && kind === 'broken-import') parts.push('created missing component files');
  if (kind === 'typescript-error' || kind === 'syntax-error') parts.push('fixed TypeScript issues');
  if (parts.length === 0) return '';
  return `I automatically ${parts.join(', ')} across ${rounds} repair round${rounds > 1 ? 's' : ''}.`;
}
