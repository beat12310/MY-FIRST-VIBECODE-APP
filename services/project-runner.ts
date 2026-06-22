import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { createWriteStream, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { PROJECT_CONFIG } from '@/lib/constants';
import { logError } from '@/lib/error-handler';
import { findAvailablePort, waitForPort } from './port-detector';

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
}

// ── Server state file ──────────────────────────────────────────────────────
// Tracks the PID and port of the currently running generated-project server
// so we can kill it before launching a new one.

const STATE_DIR = join(process.cwd(), 'generated-projects');
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

export async function installDependencies(projectPath: string, extraFlags: string[] = []): Promise<RunResult> {
  const logs: string[] = [];

  return new Promise((resolve) => {
    // Always use a writable cache dir — the default ~/.npm cache may be root-owned
    // from a prior `sudo npm install`, which causes silent EACCES failures.
    const flags = ['install', '--legacy-peer-deps', '--cache', '/tmp/npm-clean-cache', ...extraFlags];
    logs.push(`📦 Running npm ${flags.join(' ')}...`);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(npmCmd, flags, {
      cwd: projectPath,
      timeout: PROJECT_CONFIG.INSTALL_TIMEOUT,
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
      const errorLines = crashLog.split('\n')
        .filter(l => /error|failed|module not found|cannot find|unexpected token|enoent|syntax/i.test(l))
        .slice(0, 5)
        .join('\n');
      return {
        success: false,
        logs: [...logs, '❌ Server crashed immediately after launch'],
        error: errorLines || crashLog.slice(-300) || 'Server exited unexpectedly at startup',
        crashLog: crashLog.slice(-3000),
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
