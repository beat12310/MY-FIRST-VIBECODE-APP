/**
 * Flutter Build Runner
 *
 * Runs flutter pub get, flutter analyze, and flutter build apk.
 * All commands are isolated to the Flutter project directory.
 * APK builds run as background processes and report status via a state file.
 * Never touches Next.js projects or the web build pipeline.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { randomBytes } from 'crypto';

const STATE_DIR  = join(process.cwd(), 'generated-projects');
const STATE_FILE = join(STATE_DIR, '.flutter-build-state.json');

// ── State types ───────────────────────────────────────────────────────────────

export type FlutterBuildStatus = 'running' | 'done' | 'failed' | 'analyze-failed';

export interface FlutterBuildState {
  jobId:        string;
  status:       FlutterBuildStatus;
  projectPath:  string;
  apkPath?:     string;
  logs:         string[];
  startedAt:    string;
  finishedAt?:  string;
  analyzeErrors?: string[];
}

export async function readFlutterBuildState(): Promise<FlutterBuildState | null> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as FlutterBuildState;
  } catch {
    return null;
  }
}

async function writeFlutterBuildState(state: FlutterBuildState): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* non-critical */ }
}

// ── flutter pub get ────────────────────────────────────────────────────────────

export async function runFlutterPubGet(
  projectPath: string
): Promise<{ success: boolean; logs: string[]; errors: string[] }> {
  return new Promise((resolve) => {
    const logs:   string[] = [];
    const errors: string[] = [];

    const proc = spawn('flutter', ['pub', 'get'], {
      cwd: projectPath,
      timeout: 120_000,
      env: { ...process.env, PUB_CACHE: join(process.env.HOME ?? '~', '.pub-cache') },
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) logs.push(line);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) { logs.push(line); errors.push(line); }
    });
    proc.on('close', (code: number | null) => {
      resolve({ success: code === 0, logs, errors });
    });
    proc.on('error', (err: Error) => {
      resolve({ success: false, logs, errors: [`flutter pub get spawn error: ${err.message}`] });
    });
  });
}

// ── flutter analyze ────────────────────────────────────────────────────────────

export async function runFlutterAnalyze(
  projectPath: string
): Promise<{ passed: boolean; errors: string[]; warnings: string[]; raw: string }> {
  return new Promise((resolve) => {
    let raw = '';
    const proc = spawn('flutter', ['analyze', '--no-pub'], {
      cwd: projectPath,
      timeout: 60_000,
    });
    proc.stdout?.on('data', (d: Buffer) => { raw += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { raw += d.toString(); });
    proc.on('close', (code: number | null) => {
      const lines   = raw.split('\n');
      const errors  = lines.filter(l => /error •/.test(l)).slice(0, 20);
      const warnings = lines.filter(l => /warning •/.test(l)).slice(0, 10);
      resolve({ passed: code === 0, errors, warnings, raw });
    });
    proc.on('error', () => {
      resolve({ passed: false, errors: ['flutter analyze failed to start — is Flutter in PATH?'], warnings: [], raw: '' });
    });
  });
}

// ── flutter build apk (background) ────────────────────────────────────────────
// Runs in the background — caller gets a jobId and polls flutter-build-status.

export async function startFlutterApkBuild(projectPath: string): Promise<string> {
  const jobId = randomBytes(6).toString('hex');

  const state: FlutterBuildState = {
    jobId,
    status:     'running',
    projectPath,
    logs:       ['🚀 Starting APK build…'],
    startedAt:  new Date().toISOString(),
  };
  await writeFlutterBuildState(state);

  const proc = spawn(
    'flutter',
    ['build', 'apk', '--release', '--no-pub'],
    {
      cwd: projectPath,
      detached: false,
      env: { ...process.env },
    }
  );

  const logLines: string[] = [...state.logs];

  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) { logLines.push(line); }
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) { logLines.push(line); }
  });

  proc.on('close', async (code: number | null) => {
    const apkPath = join(projectPath, 'build/app/outputs/flutter-apk/app-release.apk');
    let apkExists = false;
    try { await access(apkPath); apkExists = true; } catch { /* not found */ }

    const updated: FlutterBuildState = {
      jobId,
      status:      code === 0 && apkExists ? 'done' : 'failed',
      projectPath,
      logs:        logLines,
      startedAt:   state.startedAt,
      finishedAt:  new Date().toISOString(),
      apkPath:     apkExists ? apkPath : undefined,
    };
    await writeFlutterBuildState(updated);
  });

  proc.on('error', async (err: Error) => {
    const updated: FlutterBuildState = {
      jobId,
      status:      'failed',
      projectPath,
      logs:        [...logLines, `❌ flutter build apk spawn error: ${err.message}`],
      startedAt:   state.startedAt,
      finishedAt:  new Date().toISOString(),
    };
    await writeFlutterBuildState(updated);
  });

  return jobId;
}

// ── APK file check ─────────────────────────────────────────────────────────────

export async function getApkPath(projectPath: string): Promise<string | null> {
  const apkPath = join(projectPath, 'build/app/outputs/flutter-apk/app-release.apk');
  try {
    await access(apkPath);
    return apkPath;
  } catch {
    return null;
  }
}
