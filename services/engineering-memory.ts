/**
 * Engineering Memory
 *
 * Platform-level store for successful repair patterns. Every time the
 * autonomous repair loop fixes a bug, the pattern is saved here so the
 * next occurrence is fixed instantly — without re-running the full
 * escalation pipeline.
 *
 * Storage: <platform-root>/.dwomoh/engineering-memory.json
 * Scope:   shared across ALL generated projects (patterns are portable)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepairPattern {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** RegExp source string or literal text that matches the error */
  errorPattern: string;
  /** Human-readable name of what went wrong */
  rootCause: string;
  /** What the fix does — passed into the agent-fix prompt */
  fixApproach: string;
  /** Relative file paths typically involved */
  targetFiles: string[];
  /** TypeScript error codes/messages to avoid reintroducing */
  tsErrorsToAvoid: string[];
  /** Which model tier succeeded */
  successfulTier: 'HAIKU' | 'SONNET' | 'STRONGEST';
  /** Number of times this pattern successfully fixed a bug */
  successCount: number;
}

export interface MemoryMatch {
  pattern: RepairPattern;
  confidence: 'high' | 'medium' | 'low';
  matchedOn: string; // which field matched
}

// ─── Built-in patterns ────────────────────────────────────────────────────────
// These are baked in and never overwritten — they encode known-hard bugs.

const BUILTIN_PATTERNS: RepairPattern[] = [
  {
    id: 'better-sqlite3-ts7009',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'TS7009|TS2351.*better-sqlite3|new Database\\.Database|new BetterSqlite3',
    rootCause: 'better-sqlite3 wrong constructor (TS7009/TS2351)',
    fixApproach:
      'Use default import: import Database from "better-sqlite3". ' +
      'Instantiate as: const db = new Database(dbPath). ' +
      'Do NOT use new Database.Database() or new BetterSqlite3.default(). ' +
      'Type the variable as: import type { Database as DatabaseType } from "better-sqlite3";',
    targetFiles: ['lib/managed/db.ts'],
    tsErrorsToAvoid: ['TS7009', 'TS2351'],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'tesseract-missing-package',
    createdAt: 0, updatedAt: 0,
    errorPattern: "Cannot find module 'tesseract.js'|Module not found.*tesseract",
    rootCause: 'tesseract.js not installed',
    fixApproach:
      'Install: npm install tesseract.js. ' +
      'Import as: import { createWorker } from "tesseract.js" (v4+). ' +
      'Usage: const worker = await createWorker("eng"); const { data } = await worker.recognize(imageSource); await worker.terminate().',
    targetFiles: [],
    tsErrorsToAvoid: ['TS2307'],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'route-405-missing-get',
    createdAt: 0, updatedAt: 0,
    errorPattern: '405.*Method Not Allowed|wrong-http-method|route only accepts POST.*GET',
    rootCause: 'API route missing GET export — returns 405',
    fixApproach:
      'Add to the route file: export async function GET(request: Request) { ... }. ' +
      'Import NextResponse: import { NextResponse } from "next/server". ' +
      'Return: NextResponse.json({ success: true, data: [...] }). ' +
      'DO NOT remove the existing POST handler.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'db-missing-init-table',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'SQLITE_ERROR.*no such table|initTable.*not called|table.*does not exist',
    rootCause: 'Database table not initialised before query',
    fixApproach:
      'Add initTable() call at the top of the route handler BEFORE any db.prepare() calls. ' +
      'Import: import { db, initTable, generateId } from "@/lib/managed/db". ' +
      'Call: await initTable(); as the first line inside the handler function.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'nextauth-missing-secret',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'NEXTAUTH_SECRET|\\[next-auth\\].*secret|MissingSecret',
    rootCause: 'NEXTAUTH_SECRET missing from .env.local',
    fixApproach:
      'Add NEXTAUTH_SECRET=<random-32-char-string> to .env.local. ' +
      'For preview use any string. For production run: openssl rand -base64 32.',
    targetFiles: ['.env.local'],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'missing-use-client',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'useState.*not a function|useEffect.*not a function|hooks.*only.*client|You\'re importing a component that needs',
    rootCause: 'React hook used in Server Component — missing "use client" directive',
    fixApproach:
      'Add "use client"; as the very first line of the file (before any imports). ' +
      'This is required for any component that uses React hooks (useState, useEffect, etc.).',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'invalid-tsconfig-option',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'TS5023.*Unknown compiler option|useDefineForEnumMembers|Unknown option',
    rootCause: 'Invalid TypeScript compiler option in tsconfig.json',
    fixApproach:
      'Remove the invalid option from tsconfig.json compilerOptions. ' +
      'Common hallucinated options to remove: useDefineForEnumMembers, resolvePackageJsonExports, isolatedDeclarations. ' +
      'Keep only valid Next.js 14+ tsconfig options.',
    targetFiles: ['tsconfig.json'],
    tsErrorsToAvoid: ['TS5023'],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
];

// ─── Storage ──────────────────────────────────────────────────────────────────

const MEMORY_FILE = join(process.cwd(), '.dwomoh', 'engineering-memory.json');

async function loadMemory(): Promise<RepairPattern[]> {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf-8');
    const learned: RepairPattern[] = JSON.parse(raw);
    // Merge: built-in patterns win on id conflict (don't let saved state override)
    const builtinIds = new Set(BUILTIN_PATTERNS.map(p => p.id));
    const learnedFiltered = learned.filter(p => !builtinIds.has(p.id));
    return [...BUILTIN_PATTERNS, ...learnedFiltered];
  } catch {
    return [...BUILTIN_PATTERNS];
  }
}

async function saveMemory(patterns: RepairPattern[]): Promise<void> {
  // Only save learned (non-builtin) patterns + updated builtin successCounts
  await mkdir(join(process.cwd(), '.dwomoh'), { recursive: true });
  await writeFile(MEMORY_FILE, JSON.stringify(patterns, null, 2), 'utf-8');
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Find the best matching repair pattern for the given error text and TS errors.
 * Returns null if no pattern matches with medium or higher confidence.
 */
export async function findMatchingRepair(
  errorText: string,
  tsErrors: string[] = [],
): Promise<MemoryMatch | null> {
  const patterns = await loadMemory();
  const combined = (errorText + '\n' + tsErrors.join('\n')).slice(0, 8000);

  let bestMatch: MemoryMatch | null = null;
  let bestScore = 0;

  for (const p of patterns) {
    try {
      const re = new RegExp(p.errorPattern, 'i');
      if (!re.test(combined)) continue;

      // Score: built-in patterns and high success counts rank higher
      const score = (p.successCount > 0 ? Math.min(p.successCount / 5, 1) : 0.5) +
                    (p.id.startsWith('better-sqlite') || p.id.startsWith('tesseract') ? 0.3 : 0);

      const confidence: 'high' | 'medium' | 'low' =
        score >= 0.8 ? 'high' : score >= 0.4 ? 'medium' : 'low';

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { pattern: p, confidence, matchedOn: p.errorPattern.slice(0, 60) };
      }
    } catch { /* invalid regex — skip */ }
  }

  return bestMatch && bestScore >= 0.3 ? bestMatch : null;
}

// ─── Save a successful repair ─────────────────────────────────────────────────

export interface RepairSuccessRecord {
  errorPattern: string;
  rootCause: string;
  fixApproach: string;
  targetFiles: string[];
  tsErrorsToAvoid: string[];
  successfulTier: 'HAIKU' | 'SONNET' | 'STRONGEST';
}

export async function saveRepairSuccess(record: RepairSuccessRecord): Promise<void> {
  const patterns = await loadMemory();
  const builtinIds = new Set(BUILTIN_PATTERNS.map(p => p.id));

  // Find existing pattern by matching error pattern string
  const existing = patterns.find(p => p.errorPattern === record.errorPattern);
  if (existing) {
    existing.successCount += 1;
    existing.updatedAt = Date.now();
    existing.fixApproach = record.fixApproach; // update with latest working approach
    existing.successfulTier = record.successfulTier;
  } else {
    patterns.push({
      id: `learned-${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorPattern: record.errorPattern,
      rootCause: record.rootCause,
      fixApproach: record.fixApproach,
      targetFiles: record.targetFiles,
      tsErrorsToAvoid: record.tsErrorsToAvoid,
      successfulTier: record.successfulTier,
      successCount: 1,
    });
  }

  // Also bump built-in pattern count if one matched
  for (const builtin of BUILTIN_PATTERNS) {
    if (existing?.id === builtin.id) builtin.successCount += 1;
  }

  // Only persist learned patterns (built-ins are in code)
  const learnedOnly = patterns.filter(p => !builtinIds.has(p.id));
  await saveMemory(learnedOnly).catch(() => { /* non-critical */ });
}

// ─── Format for prompt injection ──────────────────────────────────────────────

export function formatPatternForPrompt(match: MemoryMatch): string {
  const p = match.pattern;
  return [
    `[ENGINEERING MEMORY MATCH — confidence: ${match.confidence}]`,
    `Root cause: ${p.rootCause}`,
    `Known fix approach: ${p.fixApproach}`,
    p.targetFiles.length > 0 ? `Target files: ${p.targetFiles.join(', ')}` : '',
    p.tsErrorsToAvoid.length > 0 ? `TypeScript errors to avoid: ${p.tsErrorsToAvoid.join(', ')}` : '',
    `Successful tier: ${p.successfulTier} (used ${p.successCount} time(s))`,
  ].filter(Boolean).join('\n');
}
