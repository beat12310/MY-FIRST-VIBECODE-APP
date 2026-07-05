import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { createWriteStream, writeFileSync } from 'fs';
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
// NODE_PATH are the actual likely mechanism: AWS Lambda/Amplify Hosting
// runtimes commonly inject a forced `--require <instrumentation-module>`
// via NODE_OPTIONS to auto-instrument EVERY Node.js process for
// observability/credential-forwarding purposes. Unlike env vars the
// generated app's OWN dependencies might auto-detect, NODE_OPTIONS is
// applied unconditionally by Node itself to any process that inherits it —
// no prefix-based env-var stripping touches it, since the variable name
// itself doesn't start with AWS_/AMPLIFY_/etc. Explicitly clearing it (and
// NODE_PATH, which could otherwise leak module resolution to a parent
// node_modules containing Amplify-adjacent packages) removes the trigger
// at its source rather than only reacting to its failure afterward.
const EXACT_VARS_TO_CLEAR = ['NODE_OPTIONS', 'NODE_PATH'];

/**
 * Builds the environment for the generated app's dev-server child process:
 * everything from the current process EXCEPT Amplify-Hosting/Lambda-specific
 * variables, which would otherwise leak this platform's own AWS hosting
 * context into a project that has no business knowing about it.
 */
export function buildIsolatedDevServerEnv(source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
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
  return { ...clean, NODE_ENV: 'development' } as NodeJS.ProcessEnv;
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
    const port = await findAvailablePort(PROJECT_CONFIG.PORT_RANGE_START + 1);
    logs.push(`⚙️ Starting dev server on port ${port}…`);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    // Capture stdout/stderr to a log file so crashes are diagnosable.
    // stdio: pipe keeps streams alive; proc.unref() lets the server outlive this request.
    const logPath = join(projectPath, '.next-dev.log');
    try { writeFileSync(logPath, `=== dev server started at ${new Date().toISOString()} ===\n`); } catch {}

    const proc = spawn(npmCmd, ['run', 'dev', '--', '-p', String(port)], {
      cwd: projectPath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildIsolatedDevServerEnv(),
    });

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
      const crashLog = await readFile(logPath, 'utf-8').catch(() => '');
      const analysis = analyzeCrashLog(crashLog, port);
      return {
        success: false,
        logs: [...logs, '❌ Server crashed immediately after launch', `🔎 ${analysis.portDiagnostic}`],
        error: analysis.error,
        crashLog: crashLog.slice(-6000),
      };
    }

    if (outcome === 'ready') {
      logs.push(`✅ Server running on port ${port}`);
    } else {
      logs.push(`⏳ Server compiling on port ${port} — preview will load in ~60s`);
    }
    return { success: true, port, pid: proc.pid, logs };

  } catch (error) {
    logError('Failed to start dev server', error);
    return {
      success: false,
      logs,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
