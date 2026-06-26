/**
 * CSS Health Check + Auto-Fix
 *
 * Diagnoses the most common cause of "running but unstyled" preview:
 * Tailwind CSS is not set up correctly, so the server renders plain HTML.
 *
 * Common failure modes (all auto-fixable):
 *   1. globals.css is missing @tailwind directives
 *   2. app/layout.tsx does not import globals.css
 *   3. tailwind.config.js/ts is missing
 *   4. tailwind.config content paths don't cover app/** and components/**
 *   5. postcss.config.js is missing (Tailwind requires PostCSS)
 *   6. globals.css file itself is missing
 *
 * Auto-fix: writes the canonical version of each broken config.
 * After auto-fix, the dev server hot-reloads and Tailwind starts generating.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CssIssue {
  id: string;
  title: string;
  detail: string;
  autoFixable: boolean;
  fixDescription: string;
}

export interface CssHealthResult {
  healthy: boolean;
  issues: CssIssue[];
  globalsExists: boolean;
  tailwindDirectivesPresent: boolean;
  layoutImportsGlobals: boolean;
  tailwindConfigExists: boolean;
  tailwindConfigHasContentPaths: boolean;
  postcssConfigExists: boolean;
  summary: string;
}

// ─── Canonical file contents ──────────────────────────────────────────────────

const CANONICAL_GLOBALS_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #ffffff;
  --foreground: #171717;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}
`;

const CANONICAL_TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
`;

const CANONICAL_POSTCSS_CONFIG = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

// ─── Checks ───────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function readFileSafe(path: string): Promise<string | null> {
  return readFile(path, 'utf-8').catch(() => null);
}

// ─── Main check function ──────────────────────────────────────────────────────

export async function checkCssHealth(projectPath: string): Promise<CssHealthResult> {
  const issues: CssIssue[] = [];

  // Check 1: globals.css exists
  const globalsCssCandidates = [
    join(projectPath, 'app', 'globals.css'),
    join(projectPath, 'styles', 'globals.css'),
    join(projectPath, 'app', 'global.css'),
  ];
  let globalsPath: string | null = null;
  let globalsContent: string | null = null;
  for (const candidate of globalsCssCandidates) {
    if (await fileExists(candidate)) {
      globalsPath = candidate;
      globalsContent = await readFileSafe(candidate);
      break;
    }
  }

  const globalsExists = globalsPath !== null;
  if (!globalsExists) {
    issues.push({
      id: 'missing-globals-css',
      title: 'globals.css is missing',
      detail: 'app/globals.css does not exist. Next.js with Tailwind requires this file with @tailwind directives.',
      autoFixable: true,
      fixDescription: 'Create app/globals.css with @tailwind base/components/utilities directives',
    });
  }

  // Check 2: globals.css has @tailwind directives
  const tailwindDirectivesPresent = globalsContent
    ? /^@tailwind\s+base/m.test(globalsContent)
    : false;
  if (globalsExists && !tailwindDirectivesPresent) {
    issues.push({
      id: 'missing-tailwind-directives',
      title: 'globals.css is missing @tailwind directives',
      detail: 'globals.css exists but does not contain @tailwind base, @tailwind components, or @tailwind utilities.',
      autoFixable: true,
      fixDescription: 'Prepend @tailwind base/components/utilities to globals.css',
    });
  }

  // Check 3: layout.tsx imports globals.css
  const layoutCandidates = [
    join(projectPath, 'app', 'layout.tsx'),
    join(projectPath, 'app', 'layout.ts'),
    join(projectPath, 'app', 'layout.jsx'),
  ];
  let layoutContent: string | null = null;
  for (const candidate of layoutCandidates) {
    const content = await readFileSafe(candidate);
    if (content) { layoutContent = content; break; }
  }

  const layoutImportsGlobals = layoutContent
    ? /import\s+['"].*globals\.css['"]/i.test(layoutContent) ||
      /import\s+['"].*global\.css['"]/i.test(layoutContent) ||
      /import\s+['"]\.\/globals\.css['"]/i.test(layoutContent)
    : false;

  if (layoutContent && !layoutImportsGlobals) {
    issues.push({
      id: 'layout-missing-globals-import',
      title: 'app/layout.tsx does not import globals.css',
      detail: 'Tailwind styles only apply when globals.css is imported in the root layout. Without this import, no styles load.',
      autoFixable: true,
      fixDescription: "Add: import './globals.css' as the first import in app/layout.tsx",
    });
  }

  // Check 4: tailwind.config.js / tailwind.config.ts exists
  const tailwindConfigCandidates = [
    join(projectPath, 'tailwind.config.js'),
    join(projectPath, 'tailwind.config.ts'),
    join(projectPath, 'tailwind.config.mjs'),
  ];
  let tailwindConfigPath: string | null = null;
  let tailwindConfigContent: string | null = null;
  for (const candidate of tailwindConfigCandidates) {
    if (await fileExists(candidate)) {
      tailwindConfigPath = candidate;
      tailwindConfigContent = await readFileSafe(candidate);
      break;
    }
  }
  const tailwindConfigExists = tailwindConfigPath !== null;

  if (!tailwindConfigExists) {
    issues.push({
      id: 'missing-tailwind-config',
      title: 'tailwind.config.js is missing',
      detail: 'Tailwind CSS requires a config file specifying which files to scan for class names.',
      autoFixable: true,
      fixDescription: 'Create tailwind.config.js with content paths for app/** and components/**',
    });
  }

  // Check 5: tailwind config has content paths that cover app/
  const tailwindConfigHasContentPaths = tailwindConfigContent
    ? /content.*\[[\s\S]*app/m.test(tailwindConfigContent) ||
      /content.*\[[\s\S]*\.\//m.test(tailwindConfigContent)
    : false;

  if (tailwindConfigExists && !tailwindConfigHasContentPaths) {
    issues.push({
      id: 'tailwind-config-missing-content-paths',
      title: 'tailwind.config.js content paths do not cover app/ directory',
      detail: 'Tailwind purges classes from files not in the content array. If app/** is not listed, all styles are stripped.',
      autoFixable: true,
      fixDescription: "Add './app/**/*.{js,ts,jsx,tsx}' to tailwind.config.js content array",
    });
  }

  // Check 6: postcss.config.js exists
  const postcssCandidates = [
    join(projectPath, 'postcss.config.js'),
    join(projectPath, 'postcss.config.mjs'),
    join(projectPath, 'postcss.config.ts'),
  ];
  let postcssExists = false;
  for (const candidate of postcssCandidates) {
    if (await fileExists(candidate)) { postcssExists = true; break; }
  }

  if (!postcssExists) {
    issues.push({
      id: 'missing-postcss-config',
      title: 'postcss.config.js is missing',
      detail: 'Tailwind CSS runs through PostCSS. Without postcss.config.js, Tailwind cannot process CSS files.',
      autoFixable: true,
      fixDescription: 'Create postcss.config.js with tailwindcss and autoprefixer plugins',
    });
  }

  const healthy = issues.length === 0;
  const fixableCount = issues.filter(i => i.autoFixable).length;

  return {
    healthy,
    issues,
    globalsExists,
    tailwindDirectivesPresent,
    layoutImportsGlobals,
    tailwindConfigExists,
    tailwindConfigHasContentPaths,
    postcssConfigExists: postcssExists,
    summary: healthy
      ? 'CSS/Tailwind setup is correct'
      : `${issues.length} CSS issue(s) found — ${fixableCount} auto-fixable: ${issues.map(i => i.title).join('; ')}`,
  };
}

// ─── Auto-fix function ────────────────────────────────────────────────────────

export interface CssFixResult {
  fixed: string[];
  failed: string[];
}

export async function fixCssIssues(
  projectPath: string,
  healthResult: CssHealthResult,
): Promise<CssFixResult> {
  const fixed: string[] = [];
  const failed: string[] = [];

  for (const issue of healthResult.issues.filter(i => i.autoFixable)) {
    try {
      switch (issue.id) {
        case 'missing-globals-css': {
          await writeFile(join(projectPath, 'app', 'globals.css'), CANONICAL_GLOBALS_CSS, 'utf-8');
          fixed.push('Created app/globals.css');
          break;
        }

        case 'missing-tailwind-directives': {
          const existingPath = join(projectPath, 'app', 'globals.css');
          const existing = await readFileSafe(existingPath) ?? '';
          const directives = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n`;
          if (!existing.includes('@tailwind')) {
            await writeFile(existingPath, directives + existing, 'utf-8');
            fixed.push('Added @tailwind directives to globals.css');
          }
          break;
        }

        case 'layout-missing-globals-import': {
          const layoutPath = join(projectPath, 'app', 'layout.tsx');
          const existing = await readFileSafe(layoutPath);
          if (existing && !existing.includes('globals.css') && !existing.includes('global.css')) {
            const withImport = `import './globals.css';\n` + existing;
            await writeFile(layoutPath, withImport, 'utf-8');
            fixed.push("Added import './globals.css' to app/layout.tsx");
          }
          break;
        }

        case 'missing-tailwind-config': {
          await writeFile(join(projectPath, 'tailwind.config.js'), CANONICAL_TAILWIND_CONFIG, 'utf-8');
          fixed.push('Created tailwind.config.js');
          break;
        }

        case 'tailwind-config-missing-content-paths': {
          await writeFile(join(projectPath, 'tailwind.config.js'), CANONICAL_TAILWIND_CONFIG, 'utf-8');
          fixed.push('Rewrote tailwind.config.js with correct content paths');
          break;
        }

        case 'missing-postcss-config': {
          await writeFile(join(projectPath, 'postcss.config.js'), CANONICAL_POSTCSS_CONFIG, 'utf-8');
          fixed.push('Created postcss.config.js');
          break;
        }
      }
    } catch (e) {
      failed.push(`${issue.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { fixed, failed };
}
