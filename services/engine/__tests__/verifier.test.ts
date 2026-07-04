import { describe, it, expect } from 'vitest';
import { detectManagedServiceCorruption, analyzeStatic } from '../verifier';
import type { AppPlan } from '../types';

const basePlan: AppPlan = {
  intent: { appType: 'saas', secondaryTypes: [], confidence: 1, source: 'keyword' } as any,
  capabilities: [], resolvedCapabilities: [], pages: [], apiRoutes: [],
  dataModels: [], requiresAuth: false, description: 'test app', summary: 'test',
} as any;

describe('detectManagedServiceCorruption (fixed 2026-07-01)', () => {
  // ROOT CAUSE: injectManagedServices() correctly writes deterministic
  // lib/managed/db.ts and auth.ts during the INITIAL build, but a later
  // repair/edit cycle could let the model overwrite either with an
  // incompatible implementation, and nothing re-asserted them. Confirmed
  // live: a generated football-prediction app's db.ts got rewritten to
  // import '@prisma/client' (never installed — better-sqlite3 was the
  // actual, intended layer), crashing every route touching the database
  // with "Module not found."
  const installedDeps = new Set(['next', 'react', 'better-sqlite3', 'bcryptjs']);
  const PRISMA_DB_TS = `import { PrismaClient } from '@prisma/client';\nconst db = new PrismaClient();\nexport default db;\n`;
  const CORRECT_DB_TS = `export function initTable(sql: string): void {}\nexport const db = { all: () => [], get: () => undefined, run: () => {} };\n`;
  const CORRECT_AUTH_TS = `export async function registerUser() {}\nexport async function loginUser() {}\nexport async function getAuthUser() {}\nexport function getUserById() {}\n`;
  const BROKEN_AUTH_TS = `export function generateToken() {}\nexport function verifyToken() {}\n`;

  it('flags a Prisma-based db.ts for missing exports', () => {
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/db.ts', content: PRISMA_DB_TS }], installedDeps);
    expect(issues.some(i => i.includes('missing expected export') && i.endsWith('lib/managed/db.ts'))).toBe(true);
  });

  it('flags a Prisma-based db.ts for the uninstalled import', () => {
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/db.ts', content: PRISMA_DB_TS }], installedDeps);
    expect(issues.some(i => i.includes('@prisma/client') && i.endsWith('lib/managed/db.ts'))).toBe(true);
  });

  it('does not flag the correct deterministic db.ts', () => {
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/db.ts', content: CORRECT_DB_TS }], installedDeps);
    expect(issues).toHaveLength(0);
  });

  it('does not flag the correct deterministic auth.ts', () => {
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/auth.ts', content: CORRECT_AUTH_TS }], installedDeps);
    expect(issues).toHaveLength(0);
  });

  it('flags an auth.ts missing registerUser/loginUser/getAuthUser/getUserById', () => {
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/auth.ts', content: BROKEN_AUTH_TS }], installedDeps);
    expect(issues.some(i => i.includes('missing expected export') && i.endsWith('lib/managed/auth.ts'))).toBe(true);
  });

  it('does not fabricate issues when no managed files are present', () => {
    const issues = detectManagedServiceCorruption([{ path: 'app/page.tsx', content: 'export default function Home() { return null; }' }], installedDeps);
    expect(issues).toHaveLength(0);
  });

  it('does not flag Node.js builtin imports (e.g. "path") as uninstalled packages', () => {
    // A prior version of this check flagged `import { join } from 'path'`
    // inside the CORRECT db.ts template itself, since 'path' is never listed
    // in package.json dependencies (it never needs to be — it's a builtin).
    const dbWithBuiltin = `import { join } from 'path';\nexport function initTable(sql: string): void {}\nexport const db = { all: () => [], get: () => undefined, run: () => {} };\n`;
    const issues = detectManagedServiceCorruption([{ path: 'lib/managed/db.ts', content: dbWithBuiltin }], installedDeps);
    expect(issues).toHaveLength(0);
  });
});

describe('analyzeStatic — uninstalledImports (added 2026-07-01)', () => {
  // Generalization of detectManagedServiceCorruption to ANY generated file,
  // not just lib/managed/db.ts and auth.ts — the same root failure mode (a
  // model hallucinating a dependency that was never installed) can occur in
  // any route file.
  const pkgJson = JSON.stringify({ dependencies: { next: '^15', react: '^19', 'better-sqlite3': 'latest' }, devDependencies: { typescript: '^5' } });

  it('flags a random route file importing an uninstalled package', () => {
    const files = [
      { path: 'package.json', content: pkgJson },
      { path: 'app/api/orders/route.ts', content: `import { PrismaClient } from '@prisma/client';\nconst db = new PrismaClient();\n` },
    ];
    const result = analyzeStatic(basePlan, files);
    expect(result.uninstalledImports.some(i => i.includes('@prisma/client') && i.includes('app/api/orders/route.ts'))).toBe(true);
  });

  it('does not flag a file importing an actually-installed package', () => {
    const files = [
      { path: 'package.json', content: pkgJson },
      { path: 'app/api/orders/route.ts', content: `import Database from 'better-sqlite3';\n` },
    ];
    const result = analyzeStatic(basePlan, files);
    expect(result.uninstalledImports).toHaveLength(0);
  });

  it('does not flag Node.js builtins', () => {
    const files = [
      { path: 'package.json', content: pkgJson },
      { path: 'app/api/orders/route.ts', content: `import { join } from 'path';\nimport crypto from 'crypto';\n` },
    ];
    const result = analyzeStatic(basePlan, files);
    expect(result.uninstalledImports).toHaveLength(0);
  });

  it('does not flag relative or @/ project-local imports', () => {
    const files = [
      { path: 'package.json', content: pkgJson },
      { path: 'app/api/orders/route.ts', content: `import { helper } from './helper';\nimport { db } from '@/lib/managed/db';\n` },
    ];
    const result = analyzeStatic(basePlan, files);
    expect(result.uninstalledImports).toHaveLength(0);
  });

  // Added with the Zod validation pass: valid JSON with the WRONG shape
  // (e.g. "dependencies" as an array instead of a name→version record)
  // previously passed straight through — every consumer only ever read
  // pkg.dependencies with `?? {}` and never checked what actually came back,
  // which would have crashed downstream when Object.keys() ran on something
  // that isn't an object. Confirmed here: treated the same conservative way
  // a JSON.parse failure already was (falls back to no known deps), instead
  // of crashing or silently misbehaving.
  it('treats a validly-parsed but wrongly-shaped package.json as no known deps, not a crash', () => {
    const malformedPkgJson = JSON.stringify({ dependencies: ['next', 'react'] }); // array, not a record
    const files = [
      { path: 'package.json', content: malformedPkgJson },
      { path: 'app/api/orders/route.ts', content: `import Database from 'better-sqlite3';\n` },
    ];
    expect(() => analyzeStatic(basePlan, files)).not.toThrow();
    const result = analyzeStatic(basePlan, files);
    // better-sqlite3 isn't recognized as installed (the malformed deps were
    // rejected), so it's correctly flagged as uninstalled — conservative,
    // not silently trusting a corrupt shape.
    expect(result.uninstalledImports.some(i => i.includes('better-sqlite3'))).toBe(true);
  });
});
