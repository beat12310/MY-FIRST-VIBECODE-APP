import { describe, it, expect } from 'vitest';
import { extractBarePackageImports, packageNameOf, extractStaticImportSpecs } from '../check-platform-deps';

describe('extractBarePackageImports (fixed 2026-07-04)', () => {
  it('finds a real static import', () => {
    const found = extractBarePackageImports('test.ts', `import Database from 'better-sqlite3';`);
    expect(found).toEqual(['better-sqlite3']);
  });

  it('finds a real dynamic import()', () => {
    const found = extractBarePackageImports('test.ts', `const x = await import('bcryptjs');`);
    expect(found).toEqual(['bcryptjs']);
  });

  it('finds a real require()', () => {
    const found = extractBarePackageImports('test.ts', `const stripe = require('stripe');`);
    expect(found).toEqual(['stripe']);
  });

  it('does NOT treat relative or @/ imports as bare package imports', () => {
    const found = extractBarePackageImports('test.ts', `import { db } from '@/lib/managed/db';\nimport { helper } from './helper';`);
    expect(found).toEqual([]);
  });

  // ROOT CAUSE: this platform's own source is a code-GENERATION engine —
  // files like services/project-generator.ts legitimately contain large
  // string/template literals holding OTHER programs' import statements as
  // DATA, not real imports of this platform's own code. A naive text/regex
  // scan cannot tell these apart from a real import — confirmed live: the
  // first version of this checker (regex-based) reported 56 false
  // positives, entirely from template-string content in generator/
  // scaffolder files (e.g. "@prisma/client", "next-auth", "package:flutter"
  // embedded in string constants describing what a GENERATED app should
  // contain). Parsing the AST and only inspecting real ImportDeclaration/
  // CallExpression nodes fixes this structurally: text inside a string or
  // template literal is a different node kind entirely and is never
  // visited as if it were code.
  it('does NOT treat an import statement embedded inside a string literal as a real import', () => {
    const templateFileContent = `
      export const MANAGED_DB_TS = "import { PrismaClient } from '@prisma/client';\\nconst db = new PrismaClient();";
      export function buildFile() { return MANAGED_DB_TS; }
    `;
    const found = extractBarePackageImports('test.ts', templateFileContent);
    expect(found).toEqual([]);
  });

  it('does NOT treat an import statement embedded inside a template literal as a real import', () => {
    const templateFileContent = `
      const authScaffold = \`
        import NextAuth from 'next-auth';
        import CredentialsProvider from 'next-auth/providers/credentials';
      \`;
    `;
    const found = extractBarePackageImports('test.ts', templateFileContent);
    expect(found).toEqual([]);
  });

  it('correctly separates a real import from a nearby template literal containing a fake one', () => {
    const mixedContent = `
      import Database from 'better-sqlite3';
      const scaffoldCode = \`import { PrismaClient } from '@prisma/client';\`;
    `;
    const found = extractBarePackageImports('test.ts', mixedContent);
    expect(found).toEqual(['better-sqlite3']);
  });
});

describe('extractStaticImportSpecs (added after a real production outage, fixed 2026-07-05)', () => {
  // ROOT CAUSE this guards against: app/api/chat/route.ts had a top-level
  // `import { ... } from '@/services/browser-automation'`, and that module
  // has a top-level `import { chromium } from 'playwright'`. next.config.js
  // deliberately excludes node_modules/playwright/** from the production
  // bundle (to stay under Amplify's 230MB limit) -- so the moment ANY
  // request hit /api/chat, loading the route module crashed with
  // ERR_MODULE_NOT_FOUND, for every action, not just the ones that
  // actually use a browser. The fix was converting to `await import(...)`
  // inside the specific action handlers that need it -- lazy by
  // construction, so it never crashes module load. This function is what
  // makes that distinction possible: it must find ONLY static imports,
  // never dynamic ones.
  it('finds a real static import', () => {
    expect(extractStaticImportSpecs('test.ts', `import { chromium } from 'playwright';`)).toEqual(['playwright']);
  });

  it('does NOT find a dynamic await import() as a static import', () => {
    expect(extractStaticImportSpecs('test.ts', `async function f() { const { chromium } = await import('playwright'); }`)).toEqual([]);
  });

  it('does NOT find a require() call as a static import', () => {
    expect(extractStaticImportSpecs('test.ts', `const { chromium } = require('playwright');`)).toEqual([]);
  });

  it('finds a local (@/) static import spec, needed to walk the platform\'s own module graph', () => {
    expect(extractStaticImportSpecs('test.ts', `import { captureScreenshot } from '@/services/browser-automation';`))
      .toEqual(['@/services/browser-automation']);
  });

  it('finds multiple static imports in one file, static-only', () => {
    const content = `
      import { chromium } from 'playwright';
      import { helper } from '@/lib/helper';
      async function lazy() { await import('sharp'); }
    `;
    expect(extractStaticImportSpecs('test.ts', content)).toEqual(['playwright', '@/lib/helper']);
  });
});

describe('packageNameOf', () => {
  it('extracts the package name from a scoped import subpath', () => {
    expect(packageNameOf('@aws-sdk/client-dynamodb')).toBe('@aws-sdk/client-dynamodb');
  });

  it('extracts the package name from an unscoped import subpath', () => {
    expect(packageNameOf('next/server')).toBe('next');
  });

  it('leaves a bare package name unchanged', () => {
    expect(packageNameOf('react')).toBe('react');
  });
});
