import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { createWriteStream, writeFileSync, readFileSync } from 'fs';
import { createConnection } from 'net';
import { PROJECT_CONFIG } from '@/lib/constants';
import { GENERATED_ROOT } from '@/lib/workspace-paths';
import { logError } from '@/lib/error-handler';
import { findAvailablePort, waitForPort } from './port-detector';

// ── Generated-app dev-server environment isolation ──────────────────────────
// Root cause of a real production failure: spawn() below did not pass an
// explicit `env`, so the generated app's dev server (a child process)
// inherited the ENTIRE platform process's environment by Node's default
// behavior. In production this platform itself runs on AWS Amplify Hosting's
// SSR compute, which injects Amplify/Lambda-specific variables (AWS_APP_ID,
// AWS_BRANCH, _HANDLER, AWS_LAMBDA_FUNCTION_NAME, etc.) that have nothing to
// do with the generated app — but their mere presence makes something in the
// dependency tree (an Amplify SSR adapter's auto-configuration) try to start
// a local "x-amplify-credentials" listener for backend-resource access the
// generated app never needs (it uses its own lib/managed/auth.ts + better-
// sqlite3, never AWS Amplify/Cognito backend resources). That listener then
// fails with "Error: listen" under the Lambda sandbox's restricted
// networking, crashing the dev server on every attempt — confirmed live:
// "Server start failed after 3 strategies" on a real production build,
// where all 3 retries hit the identical environmental error, since retrying
// with the same inherited (and equally poisoned) environment can never help.
//
// Fix: strip Amplify/Lambda/AWS-hosting-specific variables before spawning,
// so the generated app's dev server never sees them and the credential-
// listener auto-detection never fires in the first place — the generated
// app needs none of these for its own (non-AWS-backed) functionality.
const STRIP_ENV_PREFIXES = ['AWS_', 'AMPLIFY_', 'LAMBDA_', '_X_AMZN_', '_HANDLER', '_AWS_XRAY_'];

// STRIP_ENV_PREFIXES alone was NOT sufficient — confirmed live: the same
// "[x-amplify-credentials] Credential listener could not be started: Error:
// listen" crash still occurred after that fix deployed. NODE_OPTIONS and
// NODE_PATH are a plausible mechanism (AWS Lambda/Amplify Hosting runtimes
// commonly inject a forced `--require <instrumentation-module>` via
// NODE_OPTIONS to auto-instrument every Node.js process), so both are
// cleared by exact name. But this ALSO turned out not to be sufficient —
// confirmed live a second time, AND confirmed the generated app's code is
// completely innocent: the identical generated project (same package.json,
// same source files) started cleanly in 2.9s in a clean local environment
// with no Amplify context at all. The exact trigger inside AWS Amplify
// Hosting's production compute could not be directly inspected (no shell
// access to that environment), so after two rounds of trying to PREVENT
// it, this takes the resilience approach instead (see
// buildPreviewResilienceShim below): let it fail, but don't let that
// failure crash the whole preview.
const EXACT_VARS_TO_CLEAR = ['NODE_OPTIONS', 'NODE_PATH'];

/**
 * Builds the environment for the generated app's dev-server child process:
 * everything from the current process EXCEPT Amplify-Hosting/Lambda-specific
 * variables, which would otherwise leak this platform's own AWS hosting
 * context into a project that has no business knowing about it. When
 * `shimPath` is provided, NODE_OPTIONS is set (not just cleared) to
 * `--require <shimPath>` so the resilience shim loads in the child process.
 */
export function buildIsolatedDevServerEnv(source: Record<string, string | undefined> = process.env, shimPath?: string): NodeJS.ProcessEnv {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (STRIP_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    if (EXACT_VARS_TO_CLEAR.includes(key)) continue;
    clean[key] = value;
  }
  // The platform's own process runs with NODE_ENV=production in deployed
  // environments; the generated app's PREVIEW must run `next dev` in
  // development mode regardless, so this is set explicitly (via a fresh
  // object literal -- NODE_ENV is read-only on NodeJS.ProcessEnv and can't
  // be reassigned on an already-typed object) rather than inherited.
  return {
    ...clean,
    NODE_ENV: 'development',
    ...(shimPath ? { NODE_OPTIONS: `--require ${shimPath}` } : {}),
  } as NodeJS.ProcessEnv;
}

/**
 * Source for the preview-resilience shim (see buildIsolatedDevServerEnv's
 * shimPath). Deliberately written to a temp file at runtime by
 * writePreviewResilienceShim() rather than shipped as a static file in
 * this platform's own source tree: a file ONLY ever referenced via a raw
 * path string passed to NODE_OPTIONS --require (never a real
 * import/require statement in any traced code) is invisible to Next.js's
 * build-time output file tracer and would silently be excluded from the
 * deployed serverless bundle -- exactly the class of bug already found
 * and fixed once this session for playwright/next.config.js's
 * outputFileTracingExcludes. Writing it at runtime sidesteps bundling
 * entirely: the file is guaranteed to exist on disk the moment it's
 * needed, regardless of what got traced/bundled at build time.
 *
 * Deliberately narrow: only suppresses this ONE known-safe-to-ignore
 * error pattern. Any other uncaught exception/unhandled rejection still
 * crashes the process exactly as Node's default behavior would -- this is
 * not a general error-swallower, which would hide real bugs in the
 * generated app.
 */
const PREVIEW_RESILIENCE_SHIM_SOURCE = `
const SUPPRESS_PATTERN = /x-amplify-credentials|credential listener/i;
function isSuppressible(err) {
  const msg = (err && err.message) || String(err || '');
  return SUPPRESS_PATTERN.test(msg);
}
process.on('uncaughtException', (err) => {
  if (isSuppressible(err)) {
    console.warn('[preview-resilience-shim] Suppressed non-fatal credential-listener error (preview continues): ' + (err && err.message));
    return;
  }
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (isSuppressible(reason)) {
    console.warn('[preview-resilience-shim] Suppressed non-fatal credential-listener rejection (preview continues): ' + (reason && reason.message));
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
`;

/** Writes the resilience shim to a stable temp path and returns it. Idempotent -- safe to call before every server start. */
export function writePreviewResilienceShim(): string {
  const shimPath = join(tmpdir(), 'dwomoh-preview-resilience-shim.cjs');
  try {
    writeFileSync(shimPath, PREVIEW_RESILIENCE_SHIM_SOURCE, 'utf-8');
  } catch (e) {
    logError('Failed to write preview resilience shim (non-fatal — preview continues without it)', e);
  }
  return shimPath;
}

/**
 * Analyzes a crashed dev server's captured stdout/stderr log: extracts the
 * most relevant error lines and produces a port diagnostic (requirement:
 * "show the exact port and process conflict") -- the intended preview port
 * this attempt tried to use, plus any port number(s) mentioned in the crash
 * output itself (e.g. "EADDRINUSE: address already in use :::3001", or an
 * unrelated listener trying a DIFFERENT port than the one Next.js was told
 * to use). These can differ, which is exactly the kind of mismatch worth
 * surfacing explicitly rather than only reporting the first matching error
 * line and leaving the actual port conflict implicit.
 */
export function analyzeCrashLog(crashLog: string, port: number): { errorLines: string; portDiagnostic: string; error: string } {
  const errorLines = crashLog.split('\n')
    .filter(l => /error|failed|module not found|cannot find|unexpected token|enoent|syntax|listen|credential/i.test(l))
    .slice(0, 15)
    .join('\n');

  const mentionedPorts = [...crashLog.matchAll(/:(\d{4,5})\b/g)].map(m => m[1]);
  const uniqueMentionedPorts = [...new Set(mentionedPorts)];
  const portDiagnostic = `intended preview port=${port}` +
    (uniqueMentionedPorts.length > 0 ? `; port(s) mentioned in crash output: ${uniqueMentionedPorts.join(', ')}` : '');

  const error = (errorLines || crashLog.slice(-300) || 'Server exited unexpectedly at startup') + `\n[${portDiagnostic}]`;
  return { errorLines, portDiagnostic, error };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  raw: string;
}

export interface RunResult {
  success: boolean;
  logs: string[];
  error?: string;
}

export interface ServerResult extends RunResult {
  port?: number;
  pid?: number;
  crashLog?: string;
  homePageVerified?: boolean;
  homePageStatus?: number;
  homePageError?: string;
}

// ── Server state file ──────────────────────────────────────────────────────
// Tracks the PID and port of the currently running generated-project server
// so we can kill it before launching a new one.

const STATE_DIR = GENERATED_ROOT;
const SERVER_STATE_FILE = join(STATE_DIR, '.server-state.json');

interface ServerState {
  pid: number;
  port: number;
  projectPath: string;
}

export async function readServerState(): Promise<ServerState | null> {
  try {
    const raw = await readFile(SERVER_STATE_FILE, 'utf-8');
    return JSON.parse(raw) as ServerState;
  } catch {
    return null;
  }
}

async function writeServerState(state: ServerState): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(SERVER_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logError('Could not write server state', err);
  }
}

async function killPreviousServer(logs: string[]): Promise<void> {
  const state = await readServerState();

  if (state) {
    logs.push(`🔪 Stopping previous server (pid ${state.pid}, port ${state.port})…`);

    // Kill the entire process GROUP (negative PID) so Next.js grandchild processes
    // die along with the npm parent. Without this, next-server survives and keeps
    // holding the port — causing the new project's server to fail with EADDRINUSE.
    try {
      process.kill(-state.pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { process.kill(-state.pid, 'SIGKILL'); } catch { /* already dead */ }
      logs.push(`✓ Process group ${state.pid} stopped`);
    } catch {
      logs.push(`ℹ️ Process group already stopped`);
    }

    // Belt-and-suspenders: kill any surviving process still holding the port.
    if (state.port) {
      try {
        const pids = execSync(`lsof -ti :${state.port}`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (pids) {
          for (const pid of pids.split('\n').filter(Boolean)) {
            try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ignore */ }
          }
          logs.push(`✓ Port ${state.port} forcibly cleared`);
        }
      } catch { /* lsof found nothing on that port */ }
    }
  }

  // Sweep the port range used by generated-project servers (3001–3020).
  // This catches orphaned servers that were started in a previous session and
  // were never tracked in the state file (e.g. manual `npm run dev` runs).
  for (let p = PROJECT_CONFIG.PORT_RANGE_START + 1; p <= PROJECT_CONFIG.PORT_RANGE_START + 20; p++) {
    try {
      const pids = execSync(`lsof -ti :${p}`, { encoding: 'utf-8', timeout: 2000 }).trim();
      if (pids) {
        for (const pid of pids.split('\n').filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
        }
        logs.push(`✓ Cleared orphaned process(es) on port ${p}`);
      }
    } catch { /* lsof found nothing */ }
  }

  // Give the OS time to release the port before the caller probes for availability
  await new Promise(resolve => setTimeout(resolve, 800));
}

// ── Install dependencies ───────────────────────────────────────────────────

export async function installDependencies(projectPath: string, extraFlags: string[] = [], signal?: AbortSignal): Promise<RunResult> {
  const logs: string[] = [];
  if (signal?.aborted) return { success: false, logs, error: 'Cancelled before npm install started' };

  return new Promise((resolve) => {
    // Always use a writable cache dir — the default ~/.npm cache may be root-owned
    // from a prior `sudo npm install`, which causes silent EACCES failures.
    const flags = ['install', '--legacy-peer-deps', '--cache', '/tmp/npm-clean-cache', ...extraFlags];
    logs.push(`📦 Running npm ${flags.join(' ')}...`);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // `signal` makes Node kill this child process the instant the caller aborts
    // (e.g. the orchestrator's preview-stage timeout) — not just stop waiting on it.
    const proc = spawn(npmCmd, flags, {
      cwd: projectPath,
      timeout: PROJECT_CONFIG.INSTALL_TIMEOUT,
      signal,
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logs.push(line);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logs.push(line);
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        logs.push('✅ Dependencies installed successfully');
        resolve({ success: true, logs });
      } else {
        logs.push(`❌ npm install failed with exit code ${code}`);
        resolve({ success: false, logs, error: `npm install exited with code ${code}` });
      }
    });

    proc.on('error', (err: Error) => {
      if (err.name === 'AbortError') {
        logs.push('🛑 npm install cancelled — orchestrator stage was aborted');
        resolve({ success: false, logs, error: 'Cancelled — orchestrator stage was aborted' });
        return;
      }
      logError('npm install error', err);
      resolve({ success: false, logs, error: err.message });
    });
  });
}

// ── TypeScript validation ──────────────────────────────────────────────────

export async function validateProject(projectPath: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
      cwd: projectPath,
      timeout: 60000,
    });

    let raw = '';
    proc.stdout?.on('data', (d: Buffer) => { raw += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { raw += d.toString(); });

    proc.on('close', (code: number | null) => {
      const errors = raw
        .split('\n')
        .filter(l => l.includes('error TS') || l.includes(': error:'))
        .slice(0, 20);
      resolve({ valid: code === 0, errors, raw });
    });

    proc.on('error', () => {
      resolve({ valid: false, errors: ['Could not run tsc — npx not found?'], raw: '' });
    });
  });
}

// ── Build cache ────────────────────────────────────────────────────────────

/**
 * Delete .next and .turbo cache directories so the next server start recompiles
 * from scratch. Call this before any forced restart after installing new packages.
 */
export async function clearBuildCache(projectPath: string): Promise<void> {
  await rm(join(projectPath, '.next'), { recursive: true, force: true }).catch(() => {});
  await rm(join(projectPath, '.turbo'), { recursive: true, force: true }).catch(() => {});
}

// ── Dev server logs ────────────────────────────────────────────────────────

export async function getServerLogs(projectPath: string): Promise<string> {
  const logPath = join(projectPath, '.next-dev.log');
  return readFile(logPath, 'utf-8').catch(() => '');
}

// ── Start dev server ───────────────────────────────────────────────────────

/** True if the given text mentions the SAME port in an address-already-in-use context. */
export function looksLikePortConflict(text: string, port: number): boolean {
  if (!text) return false;
  return new RegExp(`EADDRINUSE[\\s\\S]{0,40}:${port}\\b|:${port}\\b[\\s\\S]{0,40}EADDRINUSE`, 'i').test(text)
    || /EADDRINUSE/.test(text);
}

/**
 * True if the crash text indicates a missing dependency/binary rather than a
 * genuine code problem or environmental restriction — e.g. "next: command
 * not found" (npm install reported success/partial-success without `next`
 * actually landing in node_modules). This needs its own retry path: an AI
 * code-fix cycle can't install a package, and treating it as "environmental,
 * give up" would be equally wrong since reinstalling IS the fix.
 */
export function looksLikeMissingDependency(text: string): boolean {
  if (!text) return false;
  return /command not found/i.test(text)
    || /cannot find module ['"]next['"]|cannot find module ['"]react/i.test(text)
    || /MODULE_NOT_FOUND/.test(text) && /next|react/i.test(text);
}

/**
 * One spawn attempt on a specific port. Extracted from startDevServer so a
 * port conflict discovered only at spawn time (a genuine race beyond what
 * findAvailablePort's own pre-check can catch) can be retried once,
 * automatically, on a new port — a deterministic, mechanical fix, not an
 * AI code-repair cycle.
 *
 * Captures stdout/stderr into an IN-MEMORY buffer via 'data' listeners
 * attached synchronously right after spawn(), in addition to the file-based
 * log — this is the primary source for crash analysis. Root cause this
 * guards against: relying SOLELY on reading the log file back after a delay
 * has a real (if narrow) race for an extremely fast crash, e.g. Node's own
 * `--require` preload failing before npm's script even starts; an
 * in-process buffer captures bytes the instant they arrive, independent of
 * any file-write/flush timing.
 */
async function attemptServerStart(
  projectPath: string, port: number, logs: string[],
): Promise<ServerResult & { portConflict?: boolean; missingDependency?: boolean }> {
  // Pre-flight: confirm `next` is actually installed BEFORE spawning `npm run
  // dev` (which invokes `next dev` from package.json's "dev" script). Root
  // cause of a real production failure: npm install can report success (or
  // "fail, continue with available packages") without `next` actually
  // landing in node_modules, and nothing downstream verified this before
  // attempting to start the server — it just crashed with "next: command
  // not found" (sh trying to resolve a bare `next` that node_modules/.bin
  // never provided). Checking here means a doomed spawn attempt is never
  // even made — the caller gets an immediate, clear, actionable result
  // instead of a generic crash to diagnose after the fact.
  const nextBinExists = await readFile(join(projectPath, 'node_modules', 'next', 'package.json'), 'utf-8')
    .then(() => true).catch(() => false);
  if (!nextBinExists) {
    logs.push(`❌ next is not installed in node_modules — cannot start preview.`);
    return {
      success: false,
      logs,
      error: 'next is not installed in node_modules/. Run npm install (or a targeted `npm install next react react-dom`) before starting the preview.',
      missingDependency: true,
    };
  }

  logs.push(`⚙️ Starting dev server on port ${port}…`);

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Capture stdout/stderr to a log file so crashes are diagnosable.
  // stdio: pipe keeps streams alive; proc.unref() lets the server outlive this request.
  const logPath = join(projectPath, '.next-dev.log');
  try { writeFileSync(logPath, `=== dev server started at ${new Date().toISOString()} ===\n`); } catch {}

  // Fail-safe: only wire the resilience shim's NODE_OPTIONS if the written
  // file is actually readable back immediately — if writing to the temp
  // directory failed or is inaccessible to the child for any reason, fall
  // back to the safer "just clear NODE_OPTIONS" behavior rather than risk
  // spawning a process with NODE_OPTIONS pointing at a file that doesn't
  // resolve, which crashes Node at the preload stage before ANY user code
  // (or npm's own script) runs at all.
  let shimPath: string | undefined = writePreviewResilienceShim();
  try {
    readFileSync(shimPath, 'utf-8');
  } catch (e) {
    logError('Preview resilience shim not verifiably readable — spawning without it', e);
    shimPath = undefined;
  }

  const inMemoryOutput: string[] = [];
  const proc = spawn(npmCmd, ['run', 'dev', '--', '-p', String(port), '-H', '0.0.0.0'], {
    cwd: projectPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildIsolatedDevServerEnv(process.env, shimPath),
  });

  // Attached synchronously, before any await — captures output the instant
  // it arrives regardless of file I/O timing.
  proc.stdout?.on('data', (d: Buffer) => inMemoryOutput.push(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => inMemoryOutput.push(d.toString()));

  try {
    const logStream = createWriteStream(logPath, { flags: 'a' });
    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
  } catch { /* non-critical */ }

  proc.unref();

  if (proc.pid) {
    await writeServerState({ pid: proc.pid, port, projectPath });
  }

  // Race: port responds (ready), process exits early (crash), or 8s timeout (still compiling)
  type Outcome = 'ready' | 'crashed' | 'timeout';
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const settle = (v: Outcome) => { if (!settled) { settled = true; resolve(v); } };

    proc.once('exit', () => settle('crashed'));

    const portPoll = setInterval(async () => {
      try {
        const up = await new Promise<boolean>((r) => {
          const s = createConnection({ port, host: '127.0.0.1' });
          const t = setTimeout(() => { s.destroy(); r(false); }, 300);
          s.once('connect', () => { clearTimeout(t); s.destroy(); r(true); });
          s.once('error', () => { clearTimeout(t); r(false); });
        });
        if (up) { clearInterval(portPoll); settle('ready'); }
      } catch {}
    }, 1000);

    setTimeout(() => { clearInterval(portPoll); settle('timeout'); }, 8000);
  });

  if (outcome === 'crashed') {
    await new Promise(r => setTimeout(r, 300)); // let log stream flush
    const fileLog = await readFile(logPath, 'utf-8').catch(() => '');
    // Prefer the in-memory buffer (captured the instant bytes arrived); fall
    // back to the file only if the buffer is somehow empty.
    const memoryLog = inMemoryOutput.join('');
    const crashLog = memoryLog.trim() ? memoryLog : fileLog;
    const analysis = analyzeCrashLog(crashLog, port);
    const portConflict = looksLikePortConflict(crashLog, port);
    const missingDependency = looksLikeMissingDependency(crashLog);
    return {
      success: false,
      logs: [...logs, '❌ Server crashed immediately after launch', `🔎 ${analysis.portDiagnostic}`],
      error: analysis.error,
      crashLog: crashLog.slice(-6000),
      portConflict,
      missingDependency,
    };
  }

  if (outcome === 'ready') {
    logs.push(`✅ Server running on port ${port}`);
  } else {
    logs.push(`⏳ Server compiling on port ${port} — preview will load in ~60s`);
  }
  return { success: true, port, pid: proc.pid, logs };
}

/**
 * Start (or reuse) the dev server for a generated project.
 *
 * @param force  When true, always kill the running server and start fresh —
 *               use after installing new packages so Next.js picks them up.
 */
export async function startDevServer(projectPath: string, force = false): Promise<ServerResult> {
  const logs: string[] = [];

  try {
    // Fast path: if the same project is already running and its port is alive, reuse it.
    // Use a TCP socket connect instead of HTTP fetch or isPortAvailable(), because on macOS
    // the generated-project server binds as tcp46 (IPv6) and isPortAvailable() probes IPv4
    // only — it falsely reports the port as free.
    // Skip the fast path when force=true (e.g. after installing a new package).
    const existingState = await readServerState();
    if (!force && existingState && existingState.projectPath === projectPath && existingState.port) {
      const portAlive = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ port: existingState.port, host: '::1' });
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.once('error', () => { clearTimeout(timer); resolve(false); });
      }).catch(() => false);
      if (portAlive) {
        logs.push(`♻️ Reusing existing server on port ${existingState.port}`);
        return { success: true, port: existingState.port, pid: existingState.pid, logs };
      }
    }

    // ── Project isolation guard ───────────────────────────────────────────────
    // CRITICAL: Verify the generated project has its own package.json before
    // running npm. Without this check, npm traverses UP the directory tree and
    // finds the DWOMOH Vibe Code main app's package.json, serving the builder's
    // own landing page in the preview instead of the user's generated application.
    const pkgJsonPath = join(projectPath, 'package.json');
    const hasPkgJson = await readFile(pkgJsonPath, 'utf-8').then(() => true).catch(() => false);
    if (!hasPkgJson) {
      const errMsg = `Project isolation guard: no package.json found at ${projectPath}. ` +
        'The project was not generated yet, or generation failed to write files. ' +
        'Run the Generate action before starting the dev server.';
      logs.push(`❌ ${errMsg}`);
      return { success: false, logs, error: errMsg };
    }

    // Kill any previously running generated-project server first
    await killPreviousServer(logs);

    // Now find a free port — 3001 should be available again
    const initialPort = await findAvailablePort(PROJECT_CONFIG.PORT_RANGE_START + 1);
    const attempt1 = await attemptServerStart(projectPath, initialPort, logs);
    if (attempt1.success) return attempt1;

    // Confirmed live: "next: command not found" — npm install had reported
    // success/partial-success without `next` actually landing in
    // node_modules, and nothing verified this before starting the preview.
    // An AI code-fix cycle cannot install a package, so this gets its own
    // deterministic retry: reinstall, then try starting once more, rather
    // than either escalating to code repair or giving up as "environmental".
    if (attempt1.missingDependency) {
      logs.push('🔁 Missing core dependency detected at server start — reinstalling and retrying once…');
      const reinstall = await installDependencies(projectPath, ['--force']);
      logs.push(...reinstall.logs);
      if (!reinstall.success) {
        return {
          success: false,
          logs,
          error: `Dependency reinstall failed: ${reinstall.error || 'unknown npm install error'}. Cannot start preview until dependencies install successfully.`,
        };
      }
      const retryAfterInstall = await attemptServerStart(projectPath, initialPort, logs);
      return retryAfterInstall;
    }

    if (!attempt1.portConflict) return attempt1;

    // Requirement: "if port 3001 is busy, auto-select a free port" — this is
    // a deterministic, mechanical retry, not an AI code-repair cycle. Only
    // fires when the crash itself indicates a port conflict specifically
    // (EADDRINUSE), which findAvailablePort's own pre-check can miss under a
    // genuine race (something binds the port in the window between the
    // check and the actual spawn) — confirmed as a real, distinct failure
    // mode worth handling automatically rather than surfacing to the user
    // or an AI repair cycle at all.
    logs.push(`🔁 Port ${initialPort} was occupied at spawn time — auto-selecting a new port and retrying once…`);
    const retryPort = await findAvailablePort(initialPort + 1);
    const attempt2 = await attemptServerStart(projectPath, retryPort, logs);
    return attempt2;

  } catch (error) {
    logError('Failed to start dev server', error);
    return {
      success: false,
      logs,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
