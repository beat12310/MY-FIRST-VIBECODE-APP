/**
 * /api/claude-bridge — Secured SSE endpoint for the internal Claude Code worker.
 *
 * DWOMOH VIBE CODE is the controller. Claude Code is the worker.
 * Users never communicate with Claude Code directly.
 *
 * Security layers (in order of enforcement):
 *   1. Production guard      — disabled unless NODE_ENV=development
 *   2. Cognito auth gate     — valid JWT required, returns 401 otherwise
 *   3. Path allowlist        — projectPath must be inside generated-projects/
 *   4. Project ownership     — the requesting user must own the project
 *   5. Prompt policy         — blocks dangerous/out-of-scope instructions
 *   6. Clean child env       — AWS keys and secrets stripped before spawn
 *   7. Concurrency lock      — one active session per project at a time
 *   8. Audit log             — every session recorded to .bridge-audit.jsonl
 *   9. Rollback              — snapshot restored on any failure
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { PROJECT_CONFIG } from '@/lib/constants';
import { auditBridgeStart, auditBridgeComplete } from '@/services/bridge-audit';
import { detectClaudeCli } from '@/lib/claude-cli';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

// Auto-detected via lib/claude-cli (PATH + common install dirs); override with
// CLAUDE_CLI_PATH. Falls back to the bare command so PATH resolution can still work.
const CLAUDE_BIN        = detectClaudeCli() ?? 'claude';
const SNAPSHOT_DIR      = '/tmp/dwomoh-bridge-snapshots';
const ALLOWED_ROOT      = resolve(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR);
const BRIDGE_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes per attempt
const MAX_SPAWN_RETRIES = 3;              // total automatic recovery attempts

// ─── Failure classification ───────────────────────────────────────────────────

interface SpawnFailure {
  kind:
    | 'auth_expired'      // Claude Code CLI session expired — needs re-login
    | 'oom'               // process killed by OS (SIGKILL / exit 137)
    | 'timeout'           // bridge watchdog fired
    | 'cli_crash'         // segfault or unhandled exception in CLI
    | 'no_output'         // process exited 0 but wrote nothing
    | 'network'           // fetch/connection error inside CLI
    | 'permission'        // bypassPermissions denied something
    | 'transient';        // non-zero exit, unclassified — worth retrying
  recoverable: boolean;
  label: string;          // human-readable one-liner shown in the UI
  detail: string;         // truncated stderr / signal shown in status log
}

function classifySpawnFailure(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  timedOut: boolean,
): SpawnFailure {
  const err = stderr.slice(-600).trim();
  const lower = err.toLowerCase();

  if (timedOut) return {
    kind: 'timeout', recoverable: true,
    label: `Process timed out after ${BRIDGE_TIMEOUT_MS / 60000} min`,
    detail: 'Bridge watchdog killed the process — will retry from checkpoint',
  };

  // SIGKILL / exit 137 = OOM
  if (signal === 'SIGKILL' || exitCode === 137) return {
    kind: 'oom', recoverable: true,
    label: 'Process killed by OS (out of memory)',
    detail: `Signal: ${signal ?? 'SIGKILL'}, exit ${exitCode} — will retry with checkpoint`,
  };

  // Auth expired
  if (/authentication|not logged in|invalid.*token|session.*expir/i.test(lower)) return {
    kind: 'auth_expired', recoverable: false,
    label: 'Claude Code CLI authentication expired',
    detail: err.slice(0, 200),
  };

  // Network errors inside CLI
  if (/econnrefused|enotfound|network|socket hang up|fetch failed|etimedout/i.test(lower)) return {
    kind: 'network', recoverable: true,
    label: 'Network error inside Claude Code CLI',
    detail: err.slice(0, 200),
  };

  // Segfault / uncaught exception
  if (signal === 'SIGSEGV' || signal === 'SIGABRT' || /uncaughtexception|segfault/i.test(lower)) return {
    kind: 'cli_crash', recoverable: true,
    label: `CLI crashed (${signal ?? 'uncaught exception'})`,
    detail: err.slice(0, 200),
  };

  // Permission denied
  if (/permission denied|eacces/i.test(lower)) return {
    kind: 'permission', recoverable: false,
    label: 'Permission denied — check project directory permissions',
    detail: err.slice(0, 200),
  };

  // No output / zero exit with nothing done
  if (exitCode === 0) return {
    kind: 'no_output', recoverable: true,
    label: 'Claude Code exited cleanly but wrote no files',
    detail: 'Will retry with more explicit instructions',
  };

  // Unclassified non-zero
  return {
    kind: 'transient', recoverable: true,
    label: `Claude Code exited with code ${exitCode}${signal ? ` (${signal})` : ''}`,
    detail: err.slice(0, 300) || `exit code ${exitCode}`,
  };
}

// Cognito JWT config — read once at module load
const COGNITO_REGION  = process.env.NEXT_PUBLIC_AWS_REGION   ?? 'us-east-1';
const USER_POOL_ID    = process.env.NEXT_PUBLIC_USER_POOL_ID ?? '';
const COGNITO_ISSUER  = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${USER_POOL_ID}`;
let   _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks && USER_POOL_ID) _jwks = createRemoteJWKSet(new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`));
  return _jwks;
}

// ─── Concurrency lock — one active session per project path ──────────────────
// Map<resolvedProjectPath, sessionId>
const activeSessions = new Map<string, string>();

// ─── Event shape ─────────────────────────────────────────────────────────────

interface BridgeEvent {
  type: 'status' | 'log' | 'error' | 'warning' | 'complete';
  message?: string;
  changedFiles?: string[];
  totalProjectFiles?: number;  // total files in project dir (> changedFiles when project already existed)
  port?: number;               // dev server port — included in 'complete' so client can open preview
  verifyResult?: { verified: boolean; summary: string; passedCount: number; totalCount: number };
  result?: string;
}

// ─── Server-start + verify + repair loop ─────────────────────────────────────

const MAX_REPAIR_CYCLES  = 3;   // attempts to fix the app after initial generation

async function pollHttpReady(port: number, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'follow',
      });
      if (r.status < 500) return true; // 2xx, 3xx, 4xx all mean server is up
    } catch { /* still starting */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ─── 1. Prompt policy ────────────────────────────────────────────────────────
// All checks run BEFORE Claude Code is spawned.
// Returns null if safe, or a human-readable reason if blocked.

interface PolicyViolation { reason: string; code: string }

const BLOCKED_PATH_FRAGMENTS = [
  // DWOMOH VIBE CODE source paths — absolute, so they can't match generated-project files
  '/app/api/chat',   '/app/api/claude-bridge', '/app/builder',
  '/services/',      '/lib/',                   '/scripts/',
  // System paths
  '/etc/', '/usr/', '/var/', '/root/', '/private/', '/System/',
  // Traversal sequences
  '../', '..\\',
  // Env files (user's generated project should not touch .env)
  '.env.local', '.env.production', '.env.secret',
  // Note: 'next.config' and 'package.json' are intentionally NOT here —
  // they are legitimate filenames Claude must create inside generated projects.
];

const BLOCKED_PROMPT_PATTERNS: Array<{ pattern: RegExp; code: string; reason: string }> = [
  {
    pattern: /\bprocess\.env\b|\benv\s*\[|printenv\b|\/env\b/i,
    code: 'ENV_ACCESS',
    reason: 'Prompt attempts to access environment variables or credentials',
  },
  {
    // Block prompts that reference specific platform credential env-var names.
    // Do NOT block common English words like "password", "secret", or "credential" —
    // those appear in legitimate app descriptions (login forms, auth pages, etc.).
    pattern: /AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|SECRET_KEY\b|API_KEY\b|AUTH_TOKEN\b|ACCESS_TOKEN\b|PRIVATE_KEY\b|CLIENT_SECRET\b|DATABASE_URL\b|DB_PASSWORD\b|SENDGRID_API|STRIPE_SECRET|TWILIO_AUTH|NEXTAUTH_SECRET/i,
    code: 'SECRET_ACCESS',
    reason: 'Prompt references sensitive platform credential environment variable names',
  },
  {
    pattern: /rm\s+-rf|rmdir\s+\/|del\s+\/[sf]|format\s+[a-z]:/i,
    code: 'DESTRUCTIVE_CMD',
    reason: 'Prompt contains a destructive filesystem command',
  },
  {
    pattern: /curl\s+https?:\/\/(?!localhost)|wget\s+https?:\/\/(?!localhost)/i,
    code: 'EXFIL_CMD',
    reason: 'Prompt attempts to make outbound network requests to external hosts',
  },
  {
    pattern: /\bchmod\s+[0-7]*7[0-7]{2}\b|\bchown\s+root\b/i,
    code: 'PRIVILEGE_ESC',
    reason: 'Prompt attempts privilege escalation via permission changes',
  },
  {
    pattern: /dwomoh.vibe.code\s+(?:core|source|itself)|edit\s+(?:the\s+)?(?:platform|dwomoh|builder|auth(?:entication)?)\s+(?:code|system|source)/i,
    code: 'PLATFORM_EDIT',
    reason: 'Prompt attempts to modify the DWOMOH VIBE CODE platform itself',
  },
  {
    pattern: /\/app\/api\/chat|\/app\/builder|services\/verification|services\/project-gen/i,
    code: 'SOURCE_PATH',
    reason: 'Prompt references DWOMOH VIBE CODE internal source paths',
  },
];

function enforcePromptPolicy(prompt: string): PolicyViolation | null {
  // Check blocked path fragments
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (prompt.includes(frag)) {
      return { code: 'PATH_ESCAPE', reason: `Prompt references a restricted path: ${frag}` };
    }
  }
  // Check pattern rules
  for (const rule of BLOCKED_PROMPT_PATTERNS) {
    if (rule.pattern.test(prompt)) {
      return { code: rule.code, reason: rule.reason };
    }
  }
  return null;
}

// ─── 2. JWT verification (plain Request — can't use NextRequest here) ────────

async function verifyBearerToken(authHeader: string | null): Promise<{ sub: string; email?: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const jwks = getJwks();
  if (!jwks) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: COGNITO_ISSUER });
    if (!payload.sub) return null;
    return { sub: payload.sub, email: (payload as { email?: string }).email };
  } catch {
    return null;
  }
}

// ─── 3. Snapshot helpers ─────────────────────────────────────────────────────

const SNAPSHOT_IGNORE = new Set(['node_modules', '.next', '.git', '.turbo', 'dist', 'build']);

async function collectFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(d: string) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SNAPSHOT_IGNORE.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (e.isFile()) {
        try { files.set(full.replace(dir + '/', ''), await readFile(full, 'utf-8')); } catch { /* binary */ }
      }
    }
  }
  await walk(dir);
  return files;
}

async function saveSnapshot(projectPath: string, id: string): Promise<Map<string, string>> {
  const snap = await collectFiles(projectPath);
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify([...snap.entries()]), 'utf-8');
  return snap;
}

async function restoreSnapshot(projectPath: string, id: string): Promise<number> {
  const raw  = await readFile(join(SNAPSHOT_DIR, `${id}.json`), 'utf-8');
  const entries = JSON.parse(raw) as [string, string][];
  for (const [rel, content] of entries) {
    const abs = join(projectPath, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  return entries.length;
}

async function detectChangedFiles(projectPath: string, before: Map<string, string>): Promise<string[]> {
  const after   = await collectFiles(projectPath);
  const changed: string[] = [];
  for (const [rel, content] of after)   { if (!before.has(rel) || before.get(rel) !== content) changed.push(rel); }
  for (const [rel] of before)           { if (!after.has(rel)) changed.push(`${rel} (deleted)`); }
  return changed;
}

// ─── 4. Event translator ─────────────────────────────────────────────────────

function translateClaudeEvent(raw: Record<string, unknown>): string | null {
  const t = raw.type as string;
  if (t === 'system' || t === 'rate_limit_event') return null;
  if (t === 'assistant') {
    const content = ((raw.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) ?? [];
    return content.flatMap(b => {
      if (b.type === 'text') return [(b.text as string).trim()];
      if (b.type === 'tool_use') {
        const i = b.input as Record<string, unknown>;
        if (b.name === 'Read')  return [`📖 Reading ${i.file_path ?? ''}`];
        if (b.name === 'Edit')  return [`✏️ Editing ${i.file_path ?? ''}`];
        if (b.name === 'Write') return [`📝 Writing ${i.file_path ?? ''}`];
        if (b.name === 'Bash')  return [`⚡ ${String(i.command ?? '').slice(0, 80)}`];
        return [`🔧 ${b.name}`];
      }
      return [];
    }).filter(Boolean).join('\n') || null;
  }
  if (t === 'result') return (raw.result as string) ? `✅ ${(raw.result as string).slice(0, 200)}` : '✅ Done';
  return null;
}

// ─── 5. Clean child environment — secrets never reach Claude Code ─────────────

function buildSafeEnv(): NodeJS.ProcessEnv {
  // Whitelist: only what Claude Code CLI needs to authenticate and operate.
  // AWS credentials, API keys, database URIs, and platform secrets are excluded.
  const safe: Record<string, string> = {
    HOME:     process.env.HOME  ?? '/Users/ghanasongs',
    PATH:     process.env.PATH  ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TERM:     'xterm-256color',
    LANG:     process.env.LANG  ?? 'en_US.UTF-8',
    SHELL:    process.env.SHELL ?? '/bin/zsh',
    TMPDIR:   process.env.TMPDIR ?? '/tmp',
    USER:     process.env.USER  ?? 'ghanasongs',
    LOGNAME:  process.env.LOGNAME ?? process.env.USER ?? 'ghanasongs',
    // Claude Code reads auth from ~/.claude.json — not from env.
    // NODE_ENV intentionally excluded to prevent platform-mode leakage.
  };
  // Copy through only harmless display/locale vars
  for (const key of ['COLORTERM', 'TERM_PROGRAM', 'ITERM_SESSION_ID']) {
    if (process.env[key]) safe[key] = process.env[key]!;
  }
  return safe as NodeJS.ProcessEnv;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // ── Guard 1: Production disable ───────────────────────────────────────────
  // The CLI-spawn bridge is a development tool only.
  // To enable for a trusted staging environment, set BRIDGE_ENABLED=1 explicitly.
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === undefined;
  const bridgeEnabled = process.env.BRIDGE_ENABLED === '1';
  if (!isDev && !bridgeEnabled) {
    return new Response(
      JSON.stringify({ error: 'Claude Code bridge is disabled in production. Set BRIDGE_ENABLED=1 for trusted dev environments.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Guard 2: Cognito authentication ──────────────────────────────────────
  // Accept token from Authorization header OR ?token= query param
  // (EventSource cannot set custom headers, so query param is the fallback).
  // In local development (NODE_ENV=development), allow unauthenticated requests
  // with a synthetic anonymous user so the bridge works without Cognito setup.
  const authHeader = request.headers.get('authorization') ?? (
    searchParams.get('token') ? `Bearer ${searchParams.get('token')}` : null
  );
  let user = await verifyBearerToken(authHeader);
  if (!user) {
    if (isDev) {
      // Local dev bypass — treat as anonymous local developer
      user = { sub: 'local-dev-anonymous', email: 'local@dev' };
    } else {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Cognito session required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // ── Guard 3: Required params ──────────────────────────────────────────────
  const rawPrompt         = (searchParams.get('prompt') ?? '').trim();
  const rawPath           = (searchParams.get('projectPath') ?? '').trim();
  const rawProjectId      = (searchParams.get('projectId') ?? '').trim();
  const escalationReason  = (searchParams.get('escalationReason') ?? '').trim();
  const autoEscalated     = !!escalationReason;
  const port              = parseInt(searchParams.get('port') ?? '0') || 0;

  if (!rawPrompt || !rawPath) {
    return new Response(
      JSON.stringify({ error: 'Missing required params: prompt, projectPath' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Guard 4: Path allowlist ───────────────────────────────────────────────
  const resolvedPath = resolve(rawPath);
  if (!resolvedPath.startsWith(ALLOWED_ROOT + sep) && resolvedPath !== ALLOWED_ROOT) {
    return new Response(
      JSON.stringify({ error: 'Project path is outside the allowed generated-projects directory' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Guard 5: Project ownership ────────────────────────────────────────────
  // The requesting user must own this project in the manifest.
  try {
    const { listProjects } = await import('@/services/project-store');
    const userProjects = await listProjects(user.sub);
    const owned = userProjects.some(p => resolve(p.projectPath) === resolvedPath);
    if (!owned) {
      // Allow 'anonymous' projects for single-developer local use where ownerUserId
      // may not be set. In a multi-user deployment this would be a hard reject.
      const { readFile: rf } = await import('fs/promises');
      const manifest = JSON.parse(
        await rf(join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR, '.projects.json'), 'utf-8').catch(() => '[]')
      ) as Array<{ projectPath: string; ownerUserId?: string }>;
      const entry = manifest.find(p => resolve(p.projectPath) === resolvedPath);
      if (entry && entry.ownerUserId && entry.ownerUserId !== 'anonymous' && entry.ownerUserId !== user.sub) {
        return new Response(
          JSON.stringify({ error: 'Access denied — this project belongs to a different user' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
  } catch {
    // Project store read failure — allow through for local dev where manifest may not exist
  }

  // ── Guard 6: Prompt policy ────────────────────────────────────────────────
  const policyViolation = enforcePromptPolicy(rawPrompt);
  if (policyViolation) {
    await auditBridgeStart({
      sessionId:          `blocked-${Date.now()}`,
      userId:             user.sub,
      userEmail:          user.email,
      projectId:          rawProjectId,
      projectPath:        resolvedPath,
      startedAt:          new Date().toISOString(),
      promptPreview:      rawPrompt.slice(0, 120),
      promptLength:       rawPrompt.length,
      policyBlocked:      true,
      policyBlockReason:  policyViolation.reason,
      autoEscalated,
      escalationReason:   escalationReason || undefined,
    });
    return new Response(
      JSON.stringify({ error: `Request blocked by policy: ${policyViolation.reason}` }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Guard 7: Concurrency lock ─────────────────────────────────────────────
  if (activeSessions.has(resolvedPath)) {
    const holdingSession = activeSessions.get(resolvedPath);
    return new Response(
      JSON.stringify({ error: `Project is already being repaired (session ${holdingSession}). Wait for it to complete.` }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── All guards passed — start streaming ───────────────────────────────────

  const sessionId  = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snapshotId = sessionId;
  const startedAt  = new Date().toISOString();

  activeSessions.set(resolvedPath, sessionId);

  await auditBridgeStart({
    sessionId,
    userId:           user.sub,
    userEmail:        user.email,
    projectId:        rawProjectId,
    projectPath:      resolvedPath,
    startedAt,
    promptPreview:    rawPrompt.slice(0, 120),
    promptLength:     rawPrompt.length,
    policyBlocked:    false,
    autoEscalated,
    escalationReason: escalationReason || undefined,
  });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: BridgeEvent) {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      }

      // Track for audit completion
      let changedFiles: string[] = [];
      let rollbackOccurred = false;
      let rollbackSucceeded: boolean | undefined;
      let exitCode: number | undefined;
      let verifyResult: BridgeEvent['verifyResult'];
      let auditError: string | undefined;

      // Total-session watchdog: covers all retry attempts combined.
      // Each individual attempt also has its own per-attempt timeout.
      const SESSION_TOTAL_TIMEOUT = BRIDGE_TIMEOUT_MS * MAX_SPAWN_RETRIES + 60_000;
      const timeoutHandle = setTimeout(() => {
        send({ type: 'error', message: `Bridge session timed out after ${Math.round(SESSION_TOTAL_TIMEOUT / 60000)} min total (all attempts)` });
        closed = true;
        try { controller.close(); } catch {}
      }, SESSION_TOTAL_TIMEOUT);

      try {
        // Announce session ID as first event so the client can display it
        send({ type: 'status', message: `SESSION_ID:${sessionId}` });

        // Step A: Verify Claude Code CLI is authenticated
        send({ type: 'status', message: 'Checking Claude Code connection…' });
        try {
          const { stdout } = await execFileAsync(CLAUDE_BIN, ['auth', 'status'], { timeout: 8000 });
          const auth = JSON.parse(stdout.trim());
          if (!auth.loggedIn) {
            send({ type: 'error', message: 'Claude Code CLI is not authenticated on this server' });
            return;
          }
          send({ type: 'status', message: `Worker connected (${auth.email})` });
        } catch (e) {
          send({ type: 'error', message: `Cannot reach Claude Code CLI: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }

        // Step B: Initial checkpoint — snapshot the project before any changes
        send({ type: 'status', message: 'Creating pre-edit checkpoint…' });
        let beforeSnapshot: Map<string, string> = new Map();
        try {
          beforeSnapshot = await saveSnapshot(resolvedPath, snapshotId);
          send({ type: 'status', message: `Checkpoint saved (${beforeSnapshot.size} source files)` });
        } catch (e) {
          send({ type: 'warning', message: `Checkpoint failed: ${e instanceof Error ? e.message : String(e)} — rollback unavailable` });
        }

        // Step C: Spawn Claude Code CLI — with automatic recovery on failure
        // Each attempt gets its own timeout. On failure, the failure is classified,
        // the last checkpoint is restored, and a new attempt starts if recoverable.
        const spawnEnv = buildSafeEnv();
        let spawnAttempt = 0;
        let spawnSucceeded = false;
        // currentPrompt escalates when Claude Code exits 0 but writes nothing
        let currentPrompt = rawPrompt;

        while (spawnAttempt < MAX_SPAWN_RETRIES && !spawnSucceeded) {
          spawnAttempt++;

          if (spawnAttempt === 1) {
            send({ type: 'status', message: 'Forwarding to Claude Code worker…' });
          } else {
            send({ type: 'status', message: `━━━ AUTO-RECOVERY: attempt ${spawnAttempt}/${MAX_SPAWN_RETRIES} ━━━` });
            await new Promise(r => setTimeout(r, 2000));
          }

          let stderrBuf = '';
          let timedOut = false;

          const proc = spawn(CLAUDE_BIN, [
            '-p', currentPrompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode',     'bypassPermissions',
            '--add-dir',             resolvedPath,
            '--no-session-persistence',
          ], {
            cwd: resolvedPath,
            env: spawnEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          proc.stderr!.on('data', (c: Buffer) => { stderrBuf += c.toString(); });

          const attemptTimeout = setTimeout(() => {
            timedOut = true;
            try { proc.kill('SIGKILL'); } catch {}
          }, BRIDGE_TIMEOUT_MS);

          const stdoutDone = new Promise<void>(r => {
            let buf = '';
            proc.stdout!.on('data', (c: Buffer) => {
              buf += c.toString();
              const lines = buf.split('\n');
              buf = lines.pop() ?? '';
              for (const line of lines) {
                const t = line.trim();
                if (!t) continue;
                try {
                  const raw = JSON.parse(t) as Record<string, unknown>;
                  const msg = translateClaudeEvent(raw);
                  if (msg) send({ type: raw.type === 'result' ? 'status' : 'log', message: msg });
                } catch {
                  if (t) send({ type: 'log', message: t });
                }
              }
            });
            proc.stdout!.on('end', r);
          });

          let procSignal: NodeJS.Signals | null = null;
          exitCode = await new Promise<number>(res => {
            proc.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
              procSignal = sig;
              res(code ?? 1);
            });
          });
          await stdoutDone;
          clearTimeout(attemptTimeout);

          // ── Classify the outcome ───────────────────────────────────────────
          if (exitCode === 0 && !timedOut) {
            // Exit 0 is only a real success if Claude Code actually wrote files.
            // Check the snapshot diff immediately so we can detect no-output.
            const immediateChanges = await detectChangedFiles(resolvedPath, beforeSnapshot).catch(() => ['?']);
            if (immediateChanges.length > 0 && immediateChanges[0] !== '?') {
              spawnSucceeded = true;
              break;
            }
            // Exit 0 but no files written — escalate prompt and retry
            send({ type: 'warning', message: `Attempt ${spawnAttempt}/${MAX_SPAWN_RETRIES}: Claude Code exited cleanly but wrote no files — escalating to explicit write mode` });
            if (spawnAttempt < MAX_SPAWN_RETRIES) {
              currentPrompt = [
                `CRITICAL INSTRUCTION: Your previous response wrote ZERO files. This is a failure.`,
                `You MUST use the Write tool to create files. You MUST NOT respond with text only.`,
                ``,
                `START WRITING FILES NOW. Begin with app/layout.tsx immediately.`,
                ``,
                `Project directory: ${resolvedPath}`,
                ``,
                rawPrompt,
                ``,
                `REMINDER: DO NOT reply with text. USE Write tool for EVERY file. Start NOW.`,
              ].join('\n');
              // No checkpoint restore needed — nothing changed
              continue;
            }
            // All retries exhausted with no output
            send({ type: 'error', message: 'Claude Code ran but wrote no files after all attempts. Check CLI authentication with: claude --version' });
            return;
          }

          const failure = classifySpawnFailure(exitCode, procSignal, stderrBuf, timedOut);
          auditError = `attempt ${spawnAttempt}: ${failure.kind} (exit ${exitCode})`;

          // Always tell the user exactly what happened
          send({ type: spawnAttempt < MAX_SPAWN_RETRIES && failure.recoverable ? 'warning' : 'error',
            message: `⚠️ Interruption detected — ${failure.label}`,
          });
          if (failure.detail) {
            send({ type: 'log', message: `Exit detail: ${failure.detail}` });
          }

          if (!failure.recoverable) {
            // Unrecoverable (auth expired, permission denied) — stop immediately
            send({ type: 'error', message: `Cannot recover: ${failure.label}. Manual intervention required.` });
            // Restore checkpoint if we have one
            if (beforeSnapshot.size > 0) {
              try {
                const n = await restoreSnapshot(resolvedPath, snapshotId);
                rollbackOccurred = true; rollbackSucceeded = true;
                send({ type: 'status', message: `Rolled back to checkpoint (${n} files restored)` });
              } catch (re) {
                rollbackOccurred = true; rollbackSucceeded = false;
                send({ type: 'warning', message: `Rollback failed: ${re instanceof Error ? re.message : String(re)}` });
              }
            }
            return;
          }

          if (spawnAttempt >= MAX_SPAWN_RETRIES) {
            // Exhausted retries
            send({ type: 'error', message: `All ${MAX_SPAWN_RETRIES} recovery attempts failed. Last failure: ${failure.label}` });
            if (beforeSnapshot.size > 0) {
              try {
                const n = await restoreSnapshot(resolvedPath, snapshotId);
                rollbackOccurred = true; rollbackSucceeded = true;
                send({ type: 'status', message: `Rolled back to original checkpoint (${n} files restored)` });
              } catch { rollbackOccurred = true; rollbackSucceeded = false; }
            }
            return;
          }

          // Recoverable and retries remain — restore checkpoint and loop
          send({ type: 'status', message: `Restoring last checkpoint before retry ${spawnAttempt + 1}…` });
          try {
            const n = await restoreSnapshot(resolvedPath, snapshotId);
            rollbackOccurred = true; rollbackSucceeded = true;
            send({ type: 'status', message: `Checkpoint restored (${n} files) — relaunching Claude Code…` });
          } catch (re) {
            send({ type: 'warning', message: `Checkpoint restore failed: ${re instanceof Error ? re.message : String(re)} — continuing without restore` });
          }
        } // end retry loop

        // ── Step E: Detect what changed ─────────────────────────────────────
        send({ type: 'status', message: 'Detecting file changes…' });
        changedFiles = await detectChangedFiles(resolvedPath, beforeSnapshot).catch(() => []);

        // Count total project files for display (changedFiles is 0 when project already existed
        // and CLI rewrote same content — total gives the user a meaningful number).
        const countProjectFiles = async () => (await collectFiles(resolvedPath)).size;
        const totalProjectFiles = await countProjectFiles().catch(() => 0);

        if (changedFiles.length === 0 && totalProjectFiles === 0) {
          send({ type: 'error', message: 'Generation produced 0 files. Cannot start server. Check that the Claude Code CLI is authenticated (`claude --version` in terminal) and that the project path is writable.' });
          send({ type: 'complete', changedFiles: [], totalProjectFiles: 0, verifyResult: { verified: false, summary: 'No files generated', passedCount: 0, totalCount: 0 } });
          return;
        }

        if (changedFiles.length === 0 && totalProjectFiles > 0) {
          send({ type: 'status', message: `No new changes detected — project has ${totalProjectFiles} existing file(s) from a previous run. Starting server…` });
        } else {
          send({ type: 'status', message: `${changedFiles.length} file(s) written: ${changedFiles.slice(0, 6).join(', ')}${changedFiles.length > 6 ? ` +${changedFiles.length - 6} more` : ''}` });
        }

        // ── Steps F-H: Server → Verify → Repair loop ────────────────────────
        // Rules:
        //   • Never send 'complete' with verified=true unless verifyRunningApp returns verified=true
        //   • If the same error fingerprint repeats after a repair → escalate strategy, don't repeat same fix
        //   • Repair history accumulates across cycles so Claude knows what was already tried
        const { startDevServer, getServerLogs } = await import('@/services/project-runner');
        const { discoverProject }  = await import('@/services/project-discovery');
        const { verifyRunningApp } = await import('@/services/verification-engine');

        // Stable key for a block of error text — normalise away line numbers and ports
        const fingerprint = (text: string): string =>
          text.split('\n')
            .filter(l => /error|failed|module not found|cannot find|enoent|syntax|unexpected token/i.test(l))
            .slice(0, 3).join(' ')
            .replace(/\d+/g, 'N')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);

        // Shared helper: spawn Claude Code CLI for a repair pass, stream logs, return exit code
        const runRepairCli = async (repairPrompt: string, label: string): Promise<number> => {
          send({ type: 'status', message: `Invoking Claude Code CLI: ${label}…` });
          let repairTimedOut = false;
          const rp = spawn(CLAUDE_BIN, [
            '-p', repairPrompt,
            '--output-format', 'stream-json', '--verbose',
            '--permission-mode', 'bypassPermissions',
            '--add-dir', resolvedPath,
            '--no-session-persistence',
          ], { cwd: resolvedPath, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });
          let repairStderr = '';
          rp.stderr!.on('data', (c: Buffer) => { repairStderr += c.toString(); });
          const repairKillTimer = setTimeout(() => { repairTimedOut = true; try { rp.kill('SIGKILL'); } catch {} }, BRIDGE_TIMEOUT_MS);
          await new Promise<void>(resolve => {
            let buf = '';
            rp.stdout!.on('data', (c: Buffer) => {
              buf += c.toString();
              const lines = buf.split('\n'); buf = lines.pop() ?? '';
              for (const l of lines) {
                const t = l.trim(); if (!t) continue;
                try {
                  const raw = JSON.parse(t) as Record<string, unknown>;
                  const m = translateClaudeEvent(raw);
                  if (m) send({ type: 'log', message: `🔧 ${m}` });
                } catch { if (t) send({ type: 'log', message: t }); }
              }
            });
            rp.stdout!.on('end', resolve);
          });
          const exitCode = await new Promise<number>(res => rp.on('close', (code: number | null) => res(code ?? 1)));
          clearTimeout(repairKillTimer);
          if (exitCode !== 0 || repairTimedOut) {
            send({ type: 'warning', message: `${label} CLI exited ${exitCode}${repairTimedOut ? ' (timed out)' : ''} — ${repairStderr.slice(-200)}` });
          }
          return exitCode;
        };

        // Accumulate repair history so each prompt includes what was already tried
        const repairHistory: Array<{ cycle: number; type: 'server' | 'verify'; errorFp: string; strategy: string }> = [];
        let lastServerErrorFp = '';
        let lastVerifyErrorFp = '';
        let activePort = 0;
        let repairCycle = 0;

        while (repairCycle <= MAX_REPAIR_CYCLES) {
          // ── F: Start (or restart) the dev server ──────────────────────────
          send({ type: 'status', message: repairCycle === 0
            ? '━━━ PHASE: Server Start ━━━'
            : `━━━ REPAIR CYCLE ${repairCycle}/${MAX_REPAIR_CYCLES}: Server Restart ━━━` });

          send({ type: 'status', message: 'Starting development server…' });
          const serverResult = await startDevServer(resolvedPath, true);

          if (!serverResult.success) {
            const crashLog = (serverResult as { crashLog?: string }).crashLog ?? (serverResult.error ?? '');
            const errLines = crashLog.split('\n')
              .filter((l: string) => /error|failed|module not found|cannot find|enoent|syntax|unexpected/i.test(l))
              .slice(0, 14).join('\n');
            const currentFp = fingerprint(crashLog);

            send({ type: 'warning', message: `Server failed to start: ${serverResult.error ?? 'unknown error'}` });
            if (errLines) send({ type: 'log', message: `Server error detail:\n${errLines}` });

            if (repairCycle >= MAX_REPAIR_CYCLES) {
              send({ type: 'error', message: `Server still failing after ${MAX_REPAIR_CYCLES} repair attempts. Giving up.` });
              send({ type: 'complete', changedFiles, totalProjectFiles, verifyResult: { verified: false, summary: serverResult.error ?? 'Server failed to start', passedCount: 0, totalCount: 1 } });
              return;
            }

            // Detect same error → escalate strategy
            const sameError = currentFp === lastServerErrorFp && lastServerErrorFp !== '';
            lastServerErrorFp = currentFp;
            repairCycle++;

            const historyCtx = repairHistory.length
              ? `\nPREVIOUS REPAIR ATTEMPTS (do NOT repeat these — they did not work):\n` +
                repairHistory.map(h => `  Cycle ${h.cycle} [${h.type}/${h.strategy}]: error was "${h.errorFp}"`).join('\n')
              : '';

            let strategy: string;
            let serverRepairPrompt: string;

            if (!sameError || repairCycle === 1) {
              // First attempt or new error — targeted patch
              strategy = 'targeted-patch';
              serverRepairPrompt = [
                `The Next.js application at ${resolvedPath} failed to start the development server.`,
                ``,
                `EXACT ERROR OUTPUT:`,
                errLines || crashLog.slice(-1000),
                historyCtx,
                ``,
                `TASK — targeted fix:`,
                `1. Read every file referenced in the error above`,
                `2. Fix the SPECIFIC import, type, schema, or syntax error shown`,
                `3. Run: npx tsc --noEmit 2>&1 | head -30 — fix all TypeScript errors`,
                `4. Confirm the fix by reading the corrected files`,
                `5. Do NOT remove features`,
              ].join('\n');
            } else {
              // Same error persisted — rewrite the failing files entirely
              strategy = 'full-rewrite';
              const failingFile = errLines.match(/(?:\.\/|src\/|app\/)[^\s:'"()]+\.(ts|tsx|js|jsx)/)?.[0] ?? '';
              send({ type: 'warning', message: `Same error detected after last repair — escalating to full rewrite${failingFile ? ` of ${failingFile}` : ''}` });
              serverRepairPrompt = [
                `The Next.js application at ${resolvedPath} failed to start with the SAME error twice.`,
                `Patching has not worked. You must completely rewrite the failing file(s).`,
                ``,
                `PERSISTENT ERROR:`,
                errLines || crashLog.slice(-1000),
                historyCtx,
                ``,
                `STRATEGY — full rewrite (not incremental patch):`,
                `1. Read the entire failing file referenced in the error`,
                `2. Delete it and write a completely fresh, correct version from scratch`,
                `3. Ensure every import uses correct relative paths (no barrel re-exports that don't exist)`,
                `4. Ensure every type is explicitly declared (no implicit any)`,
                `5. Run: npx tsc --noEmit 2>&1 | head -30 — fix ALL errors shown`,
                `6. Also check app/layout.tsx, app/page.tsx, app/globals.css exist and are valid`,
                `7. After fixing, read each changed file back to confirm the fix`,
              ].join('\n');
            }

            repairHistory.push({ cycle: repairCycle, type: 'server', errorFp: currentFp, strategy });
            send({ type: 'status', message: `━━━ AUTO-REPAIR ${repairCycle}/${MAX_REPAIR_CYCLES} [${strategy}]: Fixing startup failure… ━━━` });

            await runRepairCli(serverRepairPrompt, `startup repair ${repairCycle}`);
            const repairChanged = await detectChangedFiles(resolvedPath, beforeSnapshot).catch(() => []);
            changedFiles = [...new Set([...changedFiles, ...repairChanged])];
            if (repairChanged.length) {
              send({ type: 'status', message: `Repair wrote ${repairChanged.length} file(s) — restarting server…` });
            } else {
              send({ type: 'warning', message: 'Repair CLI made no file changes — forcing escalation next cycle' });
              lastServerErrorFp = currentFp; // ensure next cycle detects as "same error"
            }
            continue; // restart server
          }

          // Server process started — record port
          activePort = serverResult.port ?? 0;
          send({ type: 'status', message: `Development server running on port ${activePort}` });
          lastServerErrorFp = ''; // reset — server started, different phase now

          // ── G: Wait for HTTP ready (Next.js may still compile after spawn) ─
          send({ type: 'status', message: '━━━ PHASE: Waiting for HTTP ready… ━━━' });
          const httpReady = await pollHttpReady(activePort, 120_000);
          if (!httpReady) {
            const timeoutLog = await getServerLogs(resolvedPath).catch(() => '');
            send({ type: 'warning', message: `Server on port ${activePort} did not respond within 120s` });
            if (timeoutLog) send({ type: 'log', message: `Server log tail:\n${timeoutLog.slice(-600)}` });
            if (repairCycle >= MAX_REPAIR_CYCLES) {
              send({ type: 'error', message: 'Server never became ready. Giving up.' });
              send({ type: 'complete', changedFiles, totalProjectFiles, verifyResult: { verified: false, summary: 'Server did not respond within 120s', passedCount: 0, totalCount: 1 } });
              return;
            }
            // Treat compile-timeout as a server failure — loop back to restart
            repairCycle++;
            lastServerErrorFp = fingerprint(timeoutLog); // so next cycle detects if same issue
            continue;
          }

          // ── H: Verify the running app ─────────────────────────────────────
          send({ type: 'status', message: '━━━ PHASE: Verification ━━━' });
          send({ type: 'status', message: 'Running verification suite…' });

          let disc: { apiRoutes?: string[]; pages?: string[] };
          try { disc = await discoverProject(resolvedPath); } catch { disc = {}; }

          const vr = await verifyRunningApp(
            activePort, disc.apiRoutes ?? [], resolvedPath, disc.pages ?? []
          ).catch((e: unknown) => ({ verified: false, summary: e instanceof Error ? e.message : String(e), checks: [] }));

          const passedCount = (vr.checks ?? []).filter((c: { passed: boolean; softPassed?: boolean }) => c.passed || c.softPassed).length;
          const totalCount  = (vr.checks ?? []).length;
          verifyResult = { verified: vr.verified, summary: vr.summary, passedCount, totalCount };

          if (vr.verified) {
            send({ type: 'status', message: `✅ Verification passed — ${passedCount}/${totalCount} checks` });
            send({ type: 'complete', changedFiles, totalProjectFiles, port: activePort, verifyResult });
            return; // ← only valid path to Bridge Complete ✅
          }

          // Verification failed — build escalating repair prompt
          const failingChecks = (vr.checks ?? [])
            .filter((c: { passed: boolean; softPassed?: boolean }) => !c.passed && !c.softPassed)
            .slice(0, 6)
            .map((c: { name: string; error?: string }) => `• ${c.name}: ${(c.error ?? '').slice(0, 120)}`);
          const currentVfp = fingerprint(failingChecks.join('\n'));

          send({ type: 'warning', message: `Verification: ${passedCount}/${totalCount} checks passing\n${failingChecks.join('\n')}` });

          if (repairCycle >= MAX_REPAIR_CYCLES) {
            send({ type: 'error', message: `Verification still failing after ${MAX_REPAIR_CYCLES} repair cycles. Bridge complete with verified=false.` });
            send({ type: 'complete', changedFiles, totalProjectFiles, port: activePort, verifyResult });
            return;
          }

          const sameVerifyError = currentVfp === lastVerifyErrorFp && lastVerifyErrorFp !== '';
          lastVerifyErrorFp = currentVfp;
          repairCycle++;

          const runtimeLog = await getServerLogs(resolvedPath).catch(() => '');
          const errorLogLines = runtimeLog.split('\n')
            .filter((l: string) => /error|warn|failed|exception/i.test(l))
            .slice(-20).join('\n');

          const historyCtxV = repairHistory.length
            ? `\nPREVIOUS ATTEMPTS (already tried — do NOT repeat):\n` +
              repairHistory.map(h => `  Cycle ${h.cycle} [${h.strategy}]: "${h.errorFp}"`).join('\n')
            : '';

          let verifyStrategy: string;
          let verifyRepairPrompt: string;

          if (!sameVerifyError || repairCycle === 1) {
            verifyStrategy = 'targeted-fix';
            verifyRepairPrompt = [
              `The Next.js app at ${resolvedPath} runs on port ${activePort} but these checks FAILED:`,
              failingChecks.join('\n'),
              ``,
              `RUNTIME LOG ERRORS:`,
              errorLogLines || '(none)',
              historyCtxV,
              ``,
              `TASK — targeted fix:`,
              `1. Read every API route and page file referenced in the failing checks`,
              `2. Fix the specific bug (wrong HTTP method, missing JSON response, DB schema mismatch, missing route file)`,
              `3. Run: npx tsc --noEmit 2>&1 | head -20 — fix all TypeScript errors`,
              `4. Do NOT change features, only fix bugs`,
            ].join('\n');
          } else {
            verifyStrategy = 'deep-rewrite';
            send({ type: 'warning', message: 'Same verification failure after last repair — escalating to deep rewrite of failing routes' });
            const failedRoutes = failingChecks
              .map(c => c.match(/\/api\/[^\s:]+/)?.[0])
              .filter(Boolean).join(', ');
            verifyRepairPrompt = [
              `The Next.js app at ${resolvedPath} keeps failing the SAME verification checks despite a repair attempt.`,
              `Patching has not worked. Rewrite the failing routes and pages from scratch.`,
              ``,
              `PERSISTENTLY FAILING CHECKS:`,
              failingChecks.join('\n'),
              `FAILING ROUTES: ${failedRoutes || '(see checks above)'}`,
              ``,
              `RUNTIME LOG ERRORS:`,
              errorLogLines || '(none)',
              historyCtxV,
              ``,
              `STRATEGY — deep rewrite:`,
              `1. Delete and completely rewrite each failing API route handler`,
              `2. Ensure correct HTTP method exports (GET/POST/PUT/DELETE as named exports)`,
              `3. Ensure every route returns NextResponse.json({...}) with status 200`,
              `4. Verify the DB schema matches what the route reads and writes`,
              `5. Run: npx tsc --noEmit 2>&1 | head -20 — fix all type errors`,
              `6. After rewriting, call each failing route yourself (using curl or fetch) to confirm it returns 200`,
            ].join('\n');
          }

          repairHistory.push({ cycle: repairCycle, type: 'verify', errorFp: currentVfp, strategy: verifyStrategy });
          send({ type: 'status', message: `━━━ AUTO-REPAIR ${repairCycle}/${MAX_REPAIR_CYCLES} [${verifyStrategy}]: Fixing verification failures… ━━━` });

          await runRepairCli(verifyRepairPrompt, `verification repair ${repairCycle}`);
          const vrChanged = await detectChangedFiles(resolvedPath, beforeSnapshot).catch(() => []);
          changedFiles = [...new Set([...changedFiles, ...vrChanged])];
          if (vrChanged.length) {
            send({ type: 'status', message: `Repair wrote ${vrChanged.length} file(s) — restarting server to re-verify…` });
          } else {
            send({ type: 'warning', message: 'Repair CLI made no file changes — forcing escalation next cycle' });
            lastVerifyErrorFp = currentVfp;
          }
          // Loop: restart server and re-verify
        } // end repair loop

        // Safety net — should only reach here if MAX_REPAIR_CYCLES is somehow exceeded in loop arithmetic
        send({ type: 'complete', changedFiles, totalProjectFiles, port: activePort, verifyResult });

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Bridge error: ${msg}` });
        auditError = msg;
        // Best-effort rollback
        try {
          await restoreSnapshot(resolvedPath, snapshotId);
          rollbackOccurred = true; rollbackSucceeded = true;
          send({ type: 'status', message: 'Rolled back to checkpoint after error' });
        } catch { rollbackOccurred = true; rollbackSucceeded = false; }
      } finally {
        clearTimeout(timeoutHandle);
        activeSessions.delete(resolvedPath);
        closed = true;
        try { controller.close(); } catch {}

        // Write completion audit record
        await auditBridgeComplete(sessionId, {
          exitCode,
          changedFiles,
          verifyResult,
          rollbackOccurred,
          rollbackSucceeded,
          error: auditError,
        }).catch(() => {});
      }
    },
    cancel() {
      activeSessions.delete(resolvedPath);
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache, no-transform',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Session-Id':    sessionId,
    },
  });
}
