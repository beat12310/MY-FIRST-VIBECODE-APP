/**
 * Pre-Repair Diagnostic Engine
 *
 * Runs BEFORE any AI code edit to classify the root cause and check the
 * environment. Returns actionable findings: missing packages, route method
 * mismatches, DB initialisation gaps, and OCR library issues.
 *
 * The repair loop MUST act on these findings (install packages, add exports,
 * add initTable) before calling any AI model. Many bugs are environmental,
 * not logical — they cannot be fixed by code rewrites.
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { extractAllMissingPackages, extractMissingLocalModules } from './error-recovery';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PreRepairRootCause =
  | 'missing-package'     // npm package not installed in node_modules
  | 'missing-local-file'  // @/ alias file doesn't exist on disk
  | 'route-method'        // route exports wrong HTTP method (e.g. only POST, but client calls GET)
  | 'db-init'             // initTable() not called before queries
  | 'db-column'           // column name in query differs from schema
  | 'ts-config'           // invalid tsconfig compiler option
  | 'ts-constructor'      // wrong constructor usage (TS7009, TS2351)
  | 'ts-error'            // general TypeScript type error (needs AI fix)
  | 'ocr-setup'           // tesseract.js or similar OCR library not configured
  | 'env-missing'         // required env var missing
  | 'code-logic'          // general code logic (needs AI fix)
  | 'unknown';

export interface RouteMethodIssue {
  file: string;             // relative path e.g. app/api/parse-bill/route.ts
  exportedMethods: string[]; // what the route actually exports
  issue: string;            // human-readable description
  directFix: string;        // exact code line to add to fix it
}

export interface DbIssue {
  file: string;
  issue: string;
  directFix: string;
}

export interface PreRepairDiagnostic {
  rootCause: PreRepairRootCause;
  rootCauseDetail: string;
  missingPackages: string[];
  missingLocalFiles: string[];
  routeMethodIssues: RouteMethodIssue[];
  dbIssues: DbIssue[];
  tsConfigIssues: string[];
  ocrIssues: string[];
  affectedFiles: string[];
  canAutoFix: boolean;    // true = env problem that can be fixed without AI
  autoFixActions: string[]; // human-readable list of what was auto-fixed
  enrichedContext: string;  // inject this into the agent-fix prompt
}

// ─── Package checks ───────────────────────────────────────────────────────────

async function isPackageInstalled(projectPath: string, pkg: string): Promise<boolean> {
  // Strip version specifier
  const name = pkg.split('@').filter(Boolean)[0] ?? pkg;
  const modPath = join(projectPath, 'node_modules', name);
  return access(modPath).then(() => true).catch(() => false);
}

async function getMissingInstalledPackages(projectPath: string, errorText: string): Promise<string[]> {
  const mentioned = extractAllMissingPackages(errorText);
  const missing: string[] = [];
  for (const pkg of mentioned) {
    if (!(await isPackageInstalled(projectPath, pkg))) {
      missing.push(pkg);
    }
  }
  return missing;
}

// ─── Route method checks ──────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

function parseExportedMethods(src: string): HttpMethod[] {
  return HTTP_METHODS.filter(m =>
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src)
  );
}

async function checkRouteMethods(
  projectPath: string,
  errorText: string,
  tsErrors: string[],
): Promise<RouteMethodIssue[]> {
  const issues: RouteMethodIssue[] = [];
  const allText = errorText + '\n' + tsErrors.join('\n');

  // Find route files mentioned in errors (405 responses, TS errors)
  const routePaths = new Set<string>();

  // From 405 hints
  const pathRe = /app\/api\/([\w/-]+)\/route\.ts/g;
  let m;
  while ((m = pathRe.exec(allText)) !== null) {
    routePaths.add(`app/api/${m[1]}/route.ts`);
  }

  // Also scan all route files for common mismatches
  try {
    const { readdir } = await import('fs/promises');
    async function walkApiDir(dir: string, rel: string) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) await walkApiDir(join(dir, e.name), rel + e.name + '/');
        else if (e.name === 'route.ts' || e.name === 'route.tsx') routePaths.add(`app/api/${rel}${e.name}`);
      }
    }
    await walkApiDir(join(projectPath, 'app', 'api'), '');
  } catch { /* ignore */ }

  for (const relPath of routePaths) {
    try {
      const src = await readFile(join(projectPath, relPath), 'utf-8');
      const exported = parseExportedMethods(src);

      // Route has no exports at all — this is definitely broken
      if (exported.length === 0) {
        issues.push({
          file: relPath,
          exportedMethods: [],
          issue: `${relPath} exports no HTTP method handlers — every request will 405`,
          directFix: `Add: export async function GET(request: Request) { ... }`,
        });
        continue;
      }

      // Check if error text references this route with a method mismatch
      const routeUrl = '/' + relPath.replace(/^app/, '').replace(/\/route\.tsx?$/, '');
      const hasGetCall = new RegExp(`fetch.*['"]${routeUrl}['"]|GET.*${routeUrl}|useEffect.*${routeUrl}|useSWR.*${routeUrl}|axios\\.get.*${routeUrl}`, 'i').test(allText);
      const hasPostCall = new RegExp(`fetch.*${routeUrl}.*POST|method.*POST.*${routeUrl}|axios\\.post.*${routeUrl}`, 'i').test(allText);

      if (hasGetCall && !exported.includes('GET')) {
        issues.push({
          file: relPath,
          exportedMethods: exported,
          issue: `Client code calls GET ${routeUrl} but route only exports: ${exported.join(', ') || 'nothing'}`,
          directFix: `Add: export async function GET(request: Request) { return NextResponse.json({ success: true, data: [] }); }`,
        });
      }
      if (hasPostCall && !exported.includes('POST')) {
        issues.push({
          file: relPath,
          exportedMethods: exported,
          issue: `Client code calls POST ${routeUrl} but route only exports: ${exported.join(', ') || 'nothing'}`,
          directFix: `Add: export async function POST(request: Request) { const body = await request.json(); return NextResponse.json({ success: true }); }`,
        });
      }
    } catch { /* file unreadable — skip */ }
  }

  return issues;
}

// ─── Database checks ──────────────────────────────────────────────────────────

async function checkDatabaseSetup(
  projectPath: string,
  errorText: string,
  tsErrors: string[],
): Promise<DbIssue[]> {
  const issues: DbIssue[] = [];
  const allText = errorText + '\n' + tsErrors.join('\n');

  const hasDbError =
    /SQLITE_ERROR|SQLITE_CANTOPEN|database.*locked|no such table|better-sqlite3|TS7009|TS2351/i.test(allText);

  if (!hasDbError) return issues;

  // TS7009 / TS2351 with better-sqlite3 — wrong constructor pattern
  if (/TS7009|TS2351/i.test(allText) && /better-sqlite3|Database/i.test(allText)) {
    try {
      const dbTs = await readFile(join(projectPath, 'lib/managed/db.ts'), 'utf-8');
      if (/new Database\.Database|new BetterSqlite3\.Database/i.test(dbTs)) {
        issues.push({
          file: 'lib/managed/db.ts',
          issue: 'TS7009: using new Database.Database() — should be new Database() after default import',
          directFix: `Change: import Database from 'better-sqlite3';  const db = new Database(path);`,
        });
      }
    } catch { /* file missing */ }
  }

  // Missing initTable — route file uses DB but no initTable() call
  const routeFileRe = /app\/api\/([\w/-]+)\/route\.ts/g;
  let m;
  const checkedRoutes = new Set<string>();
  while ((m = routeFileRe.exec(allText)) !== null) {
    const rel = `app/api/${m[1]}/route.ts`;
    if (checkedRoutes.has(rel)) continue;
    checkedRoutes.add(rel);
    try {
      const src = await readFile(join(projectPath, rel), 'utf-8');
      const usesDb = /from ['"]@\/lib\/managed\/db['"]|require.*db/.test(src);
      const hasInit = /initTable\s*\(/.test(src);
      if (usesDb && !hasInit) {
        issues.push({
          file: rel,
          issue: `${rel} uses the database but does not call initTable() — queries will fail on first run`,
          directFix: `Add at the top of each handler function: await initTable(); (or just call it once at module level)`,
        });
      }
    } catch { /* skip */ }
  }

  return issues;
}

// ─── OCR checks ───────────────────────────────────────────────────────────────

async function checkOcrSetup(projectPath: string, errorText: string): Promise<string[]> {
  const issues: string[] = [];
  if (!/tesseract|ocr|createWorker|recognize/i.test(errorText)) return issues;

  const hasPackage = await isPackageInstalled(projectPath, 'tesseract.js');
  if (!hasPackage) {
    issues.push('tesseract.js is not installed — run: npm install tesseract.js');
  } else {
    // Check import pattern
    try {
      const pkgJson = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf-8'));
      const ver = pkgJson.dependencies?.['tesseract.js'] ?? pkgJson.devDependencies?.['tesseract.js'];
      if (ver && parseInt(ver.replace(/[^\d]/, '')) >= 4) {
        issues.push('tesseract.js v4+ uses: import { createWorker } from "tesseract.js" — ensure the import matches the installed version');
      }
    } catch { /* ignore */ }
  }

  return issues;
}

// ─── TypeScript config checks ─────────────────────────────────────────────────

const INVALID_TSCONFIG_OPTIONS = [
  'useDefineForEnumMembers', 'resolvePackageJsonExports',
  'isolatedDeclarations', 'moduleDetection', 'verbatimModuleSyntax',
];

async function checkTsConfig(projectPath: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    const raw = JSON.parse(await readFile(join(projectPath, 'tsconfig.json'), 'utf-8'));
    const opts = raw.compilerOptions ?? {};
    for (const bad of INVALID_TSCONFIG_OPTIONS) {
      if (bad in opts) issues.push(`tsconfig.json contains invalid option: ${bad} — remove it`);
    }
    if (opts.module === 'CommonJS') issues.push('tsconfig.json module should be "esnext" not "CommonJS" for Next.js 14+');
  } catch { /* tsconfig missing or unparseable */ }
  return issues;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runPreRepairDiagnostics(
  projectPath: string,
  userRequest: string,
  errorText: string,
  tsErrors: string[],
): Promise<PreRepairDiagnostic> {
  const allErrorText = errorText + '\n' + tsErrors.join('\n');

  const [
    missingPackages,
    missingLocalFiles,
    routeMethodIssues,
    dbIssues,
    tsConfigIssues,
    ocrIssues,
  ] = await Promise.all([
    getMissingInstalledPackages(projectPath, allErrorText),
    Promise.resolve(extractMissingLocalModules(allErrorText)),
    checkRouteMethods(projectPath, errorText, tsErrors),
    checkDatabaseSetup(projectPath, errorText, tsErrors),
    checkTsConfig(projectPath),
    checkOcrSetup(projectPath, allErrorText),
  ]);

  // Determine root cause priority: package > OCR > route > db > tsconfig > code
  let rootCause: PreRepairRootCause = 'unknown';
  let rootCauseDetail = 'No specific root cause identified.';

  if (missingPackages.length > 0) {
    rootCause = 'missing-package';
    rootCauseDetail = `Missing npm package(s): ${missingPackages.join(', ')}`;
  } else if (ocrIssues.length > 0) {
    rootCause = 'ocr-setup';
    rootCauseDetail = ocrIssues[0];
  } else if (missingLocalFiles.length > 0) {
    rootCause = 'missing-local-file';
    rootCauseDetail = `Missing local file(s): ${missingLocalFiles.join(', ')}`;
  } else if (routeMethodIssues.length > 0) {
    rootCause = 'route-method';
    rootCauseDetail = routeMethodIssues[0].issue;
  } else if (dbIssues.length > 0) {
    rootCause = 'db-init';
    rootCauseDetail = dbIssues[0].issue;
    if (/TS7009|TS2351/i.test(allErrorText)) rootCause = 'ts-constructor';
  } else if (tsConfigIssues.length > 0) {
    rootCause = 'ts-config';
    rootCauseDetail = tsConfigIssues[0];
  } else if (/error TS\d+/i.test(allErrorText)) {
    rootCause = 'ts-error';
    rootCauseDetail = 'TypeScript type error — needs targeted code fix';
  } else if (/Module not found|Cannot find module/i.test(allErrorText)) {
    rootCause = 'missing-package';
    rootCauseDetail = 'Module not found (may need npm install)';
  } else if (allErrorText.trim().length > 0) {
    rootCause = 'code-logic';
    rootCauseDetail = 'Code logic error — needs AI analysis';
  }

  // canAutoFix = the fix doesn't require an AI model
  const canAutoFix =
    missingPackages.length > 0 ||
    ocrIssues.some(i => i.includes('not installed')) ||
    tsConfigIssues.length > 0;

  // Affected files from all issues
  const affectedFiles = [
    ...routeMethodIssues.map(i => i.file),
    ...dbIssues.map(i => i.file),
  ];

  // Build enriched context block for agent-fix prompt injection
  const parts: string[] = [];
  parts.push(`[PRE-REPAIR DIAGNOSTIC — run before modifying any files]`);
  parts.push(`Root cause: ${rootCause.toUpperCase()} — ${rootCauseDetail}`);

  if (missingPackages.length > 0) {
    parts.push(`\nMISSING PACKAGES (install these first, do NOT rewrite import statements):\n${missingPackages.map(p => `  npm install ${p}`).join('\n')}`);
  }
  if (routeMethodIssues.length > 0) {
    parts.push(`\nROUTE METHOD ISSUES (add missing HTTP handlers — do NOT rewrite working code):`);
    for (const ri of routeMethodIssues) {
      parts.push(`  ${ri.file}: ${ri.issue}`);
      parts.push(`  Fix: ${ri.directFix}`);
    }
  }
  if (dbIssues.length > 0) {
    parts.push(`\nDATABASE ISSUES (fix initialisation — do NOT change schema):`);
    for (const di of dbIssues) {
      parts.push(`  ${di.file}: ${di.issue}`);
      parts.push(`  Fix: ${di.directFix}`);
    }
  }
  if (tsConfigIssues.length > 0) {
    parts.push(`\nTSCONFIG ISSUES (remove invalid options — do NOT change other settings):`);
    parts.push(tsConfigIssues.map(i => `  ${i}`).join('\n'));
  }
  if (ocrIssues.length > 0) {
    parts.push(`\nOCR SETUP ISSUES:\n${ocrIssues.map(i => `  ${i}`).join('\n')}`);
  }
  parts.push(`\nUser request: ${userRequest}`);

  return {
    rootCause,
    rootCauseDetail,
    missingPackages,
    missingLocalFiles,
    routeMethodIssues,
    dbIssues,
    tsConfigIssues,
    ocrIssues,
    affectedFiles,
    canAutoFix,
    autoFixActions: [],
    enrichedContext: parts.join('\n'),
  };
}
