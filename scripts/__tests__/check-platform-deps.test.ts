import { describe, it, expect } from 'vitest';
import { extractBarePackageImports, packageNameOf } from '../check-platform-deps';

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
