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
  /**
   * If set, the deterministic-repair engine can fix this WITHOUT calling an AI model.
   * Value must match a transformId in services/deterministic-repair.ts.
   * 'none' (or undefined) = AI repair required.
   */
  directTransform?: string;
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

  // ── Auth / Database patterns (deterministic — no AI needed) ─────────────
  // IMPORTANT: lib/managed/db.ts exports: db (object with .get/.all/.run), initTable, generateId
  //            lib/managed/auth.ts exports: getAuthUser, registerUser, loginUser, AuthUser (type)
  //            NEVER use: getDb, getCurrentUser, verifyToken, createAuthUser — these do not exist
  {
    id: 'auth-missing-await',
    createdAt: 0, updatedAt: 0,
    errorPattern: "does not exist on type.*Promise.*Token|Property.*sub.*Promise|Property.*userId.*Promise|Property 'sub' does not exist on type 'Promise|Property 'email' does not exist on type 'Promise",
    rootCause: 'getAuthUser() called without await — returns Promise instead of user object',
    fixApproach:
      'Every call to getAuthUser() is async and MUST be awaited. ' +
      'Change: const auth = getAuthUser(request) → const auth = await getAuthUser(request). ' +
      'The user object has .sub (not .userId, not .id) for the user ID. ' +
      'After the fix, verify: if (!auth) return 401 guard remains in place.',
    targetFiles: [],  // determined dynamically by scanning app/api/**
    tsErrorsToAvoid: ['TS2339'],
    successfulTier: 'HAIKU',
    successCount: 0,
    directTransform: 'auth-missing-await',
  },
  {
    id: 'db-get-raw-instance',
    createdAt: 0, updatedAt: 0,
    errorPattern: "Property 'get' does not exist on type 'Database'|Property 'all' does not exist on type 'Database'|Property 'run' does not exist on type 'Database'",
    rootCause: 'lib/managed/db.ts exports raw Database instance — .get() does not exist on Database directly',
    fixApproach:
      'better-sqlite3 Database class exposes .prepare() but NOT .get() or .all() directly. ' +
      'lib/managed/db.ts must export a { all, get, run } wrapper object. ' +
      'Each method delegates to: getDb().prepare(sql).get/all/run(...params). ' +
      'NEVER export default db where db is a raw new Database() instance. ' +
      'The wrapper makes db.get<T>(sql, ...params): T | undefined available everywhere.',
    targetFiles: ['lib/managed/db.ts'],
    tsErrorsToAvoid: ['TS2339'],
    successfulTier: 'HAIKU',
    successCount: 0,
    directTransform: 'db-get-raw-instance',
  },
  {
    id: 'missing-use-client-hooks',
    createdAt: 0, updatedAt: 0,
    errorPattern: "useState.*not.*function|useEffect.*not.*function|You're importing a component that needs.*useState|hooks.*client component",
    rootCause: 'React hook used in Server Component — "use client" directive missing',
    fixApproach:
      'Add "use client"; as the FIRST line of the file — before any imports. ' +
      'This is required for any component using: useState, useEffect, useRef, useCallback, useContext, useMemo. ' +
      'Do NOT add "use client" to API route files (app/api/*) — those are always server-side.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
    directTransform: 'missing-use-client',
  },

  // ── Route structure patterns ─────────────────────────────────────────────
  {
    id: 'duplicate-route-conflict',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'two parallel pages that resolve to the same path|cannot have two parallel pages|parallel pages.*same path',
    rootCause:
      'Two Next.js page files resolve to the same URL. ' +
      'Route groups like (auth) are transparent — app/(auth)/X/page.tsx and app/X/page.tsx both resolve to /X. ' +
      'This is a build-level error that produces ZERO TypeScript errors but fails next build entirely.',
    fixApproach:
      'Delete the duplicate page. ' +
      'Keep the route-group version (e.g. app/(auth)/X/page.tsx) if the route group has a layout.tsx. ' +
      'Keep the bare version (app/X/page.tsx) if the route group has no layout. ' +
      'Never create a page at app/X/page.tsx when app/(group)/X/page.tsx already exists.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
    directTransform: 'duplicate-route-conflict',
  },

  // ── Timeout patterns ──────────────────────────────────────────────────────
  {
    id: 'platform-proxy-timeout-too-long',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'platform-proxy-timeout|AbortSignal\\.timeout\\(1[5-9]\\d{3}|[2-9]\\d{4}\\)|handler hung.*proxy|Timed out.*proxy',
    rootCause: 'Platform proxy timeout too long — exceeds 10s verification window',
    fixApproach:
      'The route calls the DWOMOH platform proxy with a timeout LONGER than the verification window (10s). ' +
      'Change: AbortSignal.timeout(15000) → AbortSignal.timeout(4000) on the proxy fetch. ' +
      'The proxy is a BEST-EFFORT enhancement — if it times out, fall through to the direct API call. ' +
      'Ensure the platform proxy call is ALWAYS in a try/catch that falls through silently.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'external-api-timeout-no-abort',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'external-api-timeout|fetch.*without.*timeout|handler hung.*fetch|no timeout.*fetch',
    rootCause: 'External API fetch() without AbortController — can hang indefinitely',
    fixApproach:
      'Every fetch() to an external API MUST have a timeout. ' +
      'Pattern: const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers }); ' +
      'Wrap in try/catch: if AbortError, return NextResponse.json({ data: [], _timeout: true }, { status: 503 }). ' +
      'Add a top-level API key check BEFORE any fetch: if (!key) return NextResponse.json({ data: [], _note: "API not configured" }). ' +
      'This prevents the route from hanging on every unconfigured request.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'SONNET',
    successCount: 0,
  },
  {
    id: 'missing-rapidapi-key-timeout',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'RAPIDAPI_KEY.*undefined|Sports API not configured|missing.*api.*key|key.*undefined.*fetch',
    rootCause: 'RAPIDAPI_KEY not set — route makes external call that may hang or return 401/403',
    fixApproach:
      'Add at the top of the route handler (BEFORE any fetch): ' +
      'const key = process.env.RAPIDAPI_KEY; ' +
      'if (!key) return NextResponse.json({ matches: [], standings: [], _mock: true, _note: "Configure RAPIDAPI_KEY for live data" }); ' +
      'This immediately returns mock data instead of hanging on an unauthenticated external call.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'infinite-retry-loop',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'infinite-retry-loop|while.*true.*fetch|recursive.*retry|handler hung.*retry',
    rootCause: 'Infinite loop or recursive retry — route never exits',
    fixApproach:
      'Replace while(true) retry with a bounded retry: let attempts = 0; while (attempts < 3) { attempts++; ... break; } ' +
      'Add exponential backoff: await new Promise(r => setTimeout(r, attempts * 500)). ' +
      'After max retries, return a safe error response instead of throwing.',
    targetFiles: [],
    tsErrorsToAvoid: [],
    successfulTier: 'SONNET',
    successCount: 0,
  },
  {
    id: 'database-lock-sqlite',
    createdAt: 0, updatedAt: 0,
    errorPattern: 'database.*locked|SQLITE_BUSY|database-lock|handler hung.*db|db.*timeout',
    rootCause: 'SQLite database lock — concurrent writes without WAL mode',
    fixApproach:
      'Enable WAL mode for concurrent access: db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000"); ' +
      'Add these pragmas immediately after opening the database connection. ' +
      'WAL mode allows concurrent reads and prevents "database is locked" errors. ' +
      'busy_timeout tells SQLite to wait up to 5s before throwing SQLITE_BUSY.',
    targetFiles: ['lib/managed/db.ts'],
    tsErrorsToAvoid: [],
    successfulTier: 'HAIKU',
    successCount: 0,
  },

  // ── Hallucinated import names ────────────────────────────────────────────
  {
    id: 'hallucinated-db-export',
    createdAt: 0, updatedAt: 0,
    errorPattern: "Module.*has no exported member.*getDb|getDb.*is not exported|Module.*lib/managed/db.*getDb|'getDb' is not exported",
    rootCause: "Hallucinated import 'getDb' — lib/managed/db.ts exports 'db' (not 'getDb')",
    fixApproach:
      "lib/managed/db.ts does NOT export getDb. It exports: db (the wrapper object), initTable, generateId. " +
      "Change: import { getDb } from '@/lib/managed/db' → import { db } from '@/lib/managed/db'. " +
      "Usage: db.get<T>(sql, ...params), db.all<T>(sql, ...params), db.run(sql, ...params).",
    targetFiles: [],
    tsErrorsToAvoid: ['TS2305'],
    successfulTier: 'HAIKU',
    successCount: 0,
  },
  {
    id: 'hallucinated-auth-export',
    createdAt: 0, updatedAt: 0,
    errorPattern: "Module.*has no exported member.*getCurrentUser|getCurrentUser.*is not exported|'getCurrentUser' is not exported|Module.*lib/managed/auth.*getCurrentUser",
    rootCause: "Hallucinated import 'getCurrentUser' — lib/managed/auth.ts exports 'getAuthUser'",
    fixApproach:
      "lib/managed/auth.ts does NOT export getCurrentUser or verifyToken. It exports: getAuthUser (async). " +
      "Change: import { getCurrentUser } from '@/lib/managed/auth' → import { getAuthUser } from '@/lib/managed/auth'. " +
      "Usage: const auth = await getAuthUser(request); if (!auth) return 401; auth.sub is the user ID.",
    targetFiles: [],
    tsErrorsToAvoid: ['TS2305'],
    successfulTier: 'HAIKU',
    successCount: 0,
  },

  // ── Next.js 15 async params ──────────────────────────────────────────────
  {
    id: 'nextjs15-sync-params',
    createdAt: 0, updatedAt: 0,
    errorPattern: "does not satisfy the constraint.*RouteHandlerConfig|Types of property 'GET' are incompatible.*params.*Promise|params.*Promise<.*>.*not assignable.*params.*{",
    rootCause: 'Next.js 15: route handler params are now Promise<{id}> — sync destructuring fails type check',
    fixApproach:
      'In Next.js 15, dynamic route handler context params are ASYNC. ' +
      'Change: { params }: { params: { id: string } } → { params }: { params: Promise<{ id: string }> } ' +
      'Then destructure with await at the top of the handler: const { id } = await params; ' +
      'Apply this to ALL exported handler functions (GET, POST, PUT, DELETE, PATCH) in the same file. ' +
      'This applies to ALL files under app/api/**/[id]/route.ts or any dynamic segment route.',
    targetFiles: [],
    tsErrorsToAvoid: ['TS2344'],
    successfulTier: 'HAIKU',
    successCount: 1,
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
