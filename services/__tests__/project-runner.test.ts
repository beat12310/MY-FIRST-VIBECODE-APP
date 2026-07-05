import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { buildIsolatedDevServerEnv, analyzeCrashLog, writePreviewResilienceShim } from '../project-runner';
import { isEnvironmentalServerError } from '@/lib/server-start-diagnostics';

/**
 * Regression coverage for a real live-production incident: the generated
 * app's dev server (a spawned child process) inherited the ENTIRE platform
 * process's environment by Node's default spawn() behavior. In production
 * this platform runs on AWS Amplify Hosting's SSR compute, which injects
 * Amplify/Lambda-specific variables (AWS_APP_ID, AWS_BRANCH, _HANDLER,
 * AWS_LAMBDA_FUNCTION_NAME, etc.) that have nothing to do with the
 * generated app -- but their mere presence made something in the
 * generated app's dependency tree try to start a local
 * "x-amplify-credentials" listener, which failed with "Error: listen"
 * under the Lambda sandbox's restricted networking, crashing the dev
 * server on every attempt. buildIsolatedDevServerEnv is the fix: strip
 * these variables before spawning so the generated app's dev server never
 * sees them.
 */
describe('buildIsolatedDevServerEnv — the exact live production failure', () => {
  it('strips AWS_-prefixed variables (AWS_APP_ID, AWS_BRANCH, etc.)', () => {
    const env = buildIsolatedDevServerEnv({
      PATH: '/usr/bin', AWS_APP_ID: 'd2wdmbsbhl4qo8', AWS_BRANCH: 'main', AWS_REGION: 'us-east-1',
    });
    expect(env.AWS_APP_ID).toBeUndefined();
    expect(env.AWS_BRANCH).toBeUndefined();
    expect(env.AWS_REGION).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips AMPLIFY_-prefixed variables', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', AMPLIFY_SENTINEL_APP_ID: 'x' });
    expect(env.AMPLIFY_SENTINEL_APP_ID).toBeUndefined();
  });

  it('strips Lambda-specific variables (_HANDLER, AWS_LAMBDA_FUNCTION_NAME, LAMBDA_TASK_ROOT)', () => {
    const env = buildIsolatedDevServerEnv({
      PATH: '/usr/bin',
      _HANDLER: 'index.handler',
      AWS_LAMBDA_FUNCTION_NAME: 'amplify-fn',
      LAMBDA_TASK_ROOT: '/var/task',
      _X_AMZN_TRACE_ID: 'abc123',
    });
    expect(env._HANDLER).toBeUndefined();
    expect(env.AWS_LAMBDA_FUNCTION_NAME).toBeUndefined();
    expect(env.LAMBDA_TASK_ROOT).toBeUndefined();
    expect(env._X_AMZN_TRACE_ID).toBeUndefined();
  });

  it('preserves everything else the dev server genuinely needs (PATH, HOME, etc.)', () => {
    const env = buildIsolatedDevServerEnv({
      PATH: '/usr/bin:/bin', HOME: '/home/user', RAPIDAPI_KEY: 'some-key', BEDROCK_MODEL_ID: 'some-model',
    });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.RAPIDAPI_KEY).toBe('some-key');
    expect(env.BEDROCK_MODEL_ID).toBe('some-model');
  });

  it('always sets NODE_ENV=development regardless of the platform\'s own NODE_ENV', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', NODE_ENV: 'production' });
    expect(env.NODE_ENV).toBe('development');
  });

  // ROOT CAUSE of the fix's first (incomplete) attempt: prefix-based
  // stripping (AWS_/AMPLIFY_/LAMBDA_/etc.) did NOT stop the same
  // "x-amplify-credentials" crash from recurring live, because
  // NODE_OPTIONS doesn't start with any of those prefixes. AWS Lambda/
  // Amplify Hosting runtimes commonly inject a forced `--require
  // <instrumentation-module>` via NODE_OPTIONS to auto-instrument EVERY
  // Node.js process -- since NODE_OPTIONS applies unconditionally to any
  // process that inherits it (unlike env vars a dependency merely
  // detects), it must be cleared explicitly by exact name, not by prefix.
  it('clears NODE_OPTIONS even though it does not match any AWS_/AMPLIFY_/LAMBDA_ prefix', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--require /opt/amplify-instrumentation.js' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('clears NODE_PATH (could otherwise leak module resolution to a parent node_modules)', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', NODE_PATH: '/opt/nodejs/node_modules' });
    expect(env.NODE_PATH).toBeUndefined();
  });

  // ROOT CAUSE: two rounds of trying to PREVENT the x-amplify-credentials
  // crash (prefix-stripping, then NODE_OPTIONS/NODE_PATH clearing) were
  // both deployed and the identical crash still occurred live -- and the
  // generated app's own code was definitively ruled out (the exact same
  // project started cleanly in 2.9s in a clean local environment). Rather
  // than continue guessing at an unreachable production-only trigger, this
  // sets NODE_OPTIONS to load a resilience shim that suppresses ONLY this
  // known-safe-to-ignore failure instead of letting it crash the process.
  it('sets NODE_OPTIONS to --require the shim when a shimPath is provided (does not just clear it)', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--some-other-flag' }, '/tmp/my-shim.cjs');
    expect(env.NODE_OPTIONS).toBe('--require /tmp/my-shim.cjs');
  });

  it('still clears NODE_OPTIONS entirely when no shimPath is given', () => {
    const env = buildIsolatedDevServerEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--require /opt/amplify-instrumentation.js' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('defaults to the real process.env when no source is provided', () => {
    const env = buildIsolatedDevServerEnv();
    expect(env.NODE_ENV).toBe('development');
    expect(typeof env).toBe('object');
  });
});

describe('analyzeCrashLog — port/process-conflict diagnostic', () => {
  it('extracts the intended port and reports it even with no ports mentioned in the crash output', () => {
    const result = analyzeCrashLog('Error: something went wrong\nModule not found: fs', 3005);
    expect(result.portDiagnostic).toContain('intended preview port=3005');
    expect(result.portDiagnostic).not.toContain('port(s) mentioned');
  });

  it('extracts port numbers mentioned in the crash output (e.g. EADDRINUSE)', () => {
    const result = analyzeCrashLog('Error: listen EADDRINUSE: address already in use :::3005', 3005);
    expect(result.portDiagnostic).toContain('3005');
    expect(result.portDiagnostic).toContain('port(s) mentioned in crash output');
  });

  it('surfaces a DIFFERENT port than the intended one when the crash output mentions one', () => {
    // e.g. an unrelated listener tries some other port entirely -- worth
    // surfacing as a real mismatch, not just "the server didn't start".
    const result = analyzeCrashLog('Error: listen EACCES: permission denied 127.0.0.1:9229', 3005);
    expect(result.portDiagnostic).toContain('intended preview port=3005');
    expect(result.portDiagnostic).toContain('9229');
  });
});

/**
 * Regression test (per explicit requirement): a generated car sales
 * marketplace app must be able to preview without an x-amplify-credentials
 * crash taking down the whole dev server or triggering a doomed AI
 * code-repair cycle. This is an integration-shaped test at the unit level:
 * it feeds analyzeCrashLog a REALISTIC crash log matching the exact live
 * production failure, then confirms the resulting error text is correctly
 * classified as environmental (so the builder's retry loop skips AI
 * code-fix strategies and never escalates to the repair bridge for it) --
 * exercising the full chain from raw crash output to the classification
 * decision that determines whether the user sees a doomed repair cycle or
 * a clear, honest message, without needing a real multi-minute Bedrock
 * build to prove the fix works.
 */
describe('car sales marketplace preview — full crash-to-classification chain (2026-07-05)', () => {
  it('a realistic x-amplify-credentials crash log is captured AND correctly classified as environmental', () => {
    const realisticCrashLog = [
      '=== dev server started at 2026-07-05T16:40:00.000Z ===',
      '> car-sales-marketplace@0.1.0 dev',
      '> next dev -p 3005',
      '',
      'ready - started server on 0.0.0.0:3005, url: http://localhost:3005',
      '[x-amplify-credentials] Credential listener could not be started: Error: listen EACCES: permission denied 127.0.0.1:4566',
      '    at Server.setupListenHandle [as _listen2] (node:net:1817:21)',
      'Node.js process exited with code 1',
    ].join('\n');

    const analysis = analyzeCrashLog(realisticCrashLog, 3005);

    // The crash text made it into the returned error (not swallowed/lost).
    expect(analysis.error).toContain('x-amplify-credentials');
    // Both the intended port (3005, correctly running) and the conflicting
    // listener's port (4566) are surfaced, showing they're NOT the same
    // port -- the actual preview server was fine; a separate, unrelated
    // listener failed.
    expect(analysis.portDiagnostic).toContain('intended preview port=3005');
    expect(analysis.portDiagnostic).toContain('4566');
    // The full chain: this error must be classified as environmental, so
    // the builder's retry loop never wastes an AI code-fix cycle or
    // escalates to the repair bridge for it.
    expect(isEnvironmentalServerError(analysis.error)).toBe(true);
  });
});

describe('writePreviewResilienceShim — the actual crash-suppression mechanism', () => {
  it('writes a shim file containing the suppression pattern and process handlers', () => {
    const shimPath = writePreviewResilienceShim();
    const content = readFileSync(shimPath, 'utf-8');
    expect(content).toContain('x-amplify-credentials');
    expect(content).toContain('uncaughtException');
    expect(content).toContain('unhandledRejection');
  });

  it('returns the same stable path on repeated calls (idempotent, safe to call before every server start)', () => {
    const path1 = writePreviewResilienceShim();
    const path2 = writePreviewResilienceShim();
    expect(path1).toBe(path2);
  });

  // The most direct possible test of the actual mechanism: spawn a REAL
  // Node.js child process that throws the exact reported error, with the
  // shim loaded via NODE_OPTIONS=--require, and confirm the process does
  // NOT crash -- proving this works with Node's real uncaughtException
  // behavior, not just checking the shim file's text content.
  it('a real child process throwing the exact reported error does NOT crash when the shim is loaded', () => {
    const shimPath = writePreviewResilienceShim();
    const result = spawnSync(process.execPath, [
      '-e',
      `throw new Error('[x-amplify-credentials] Credential listener could not be started: Error: listen EACCES: permission denied 127.0.0.1:4566')`,
    ], {
      env: { ...process.env, NODE_OPTIONS: `--require ${shimPath}` },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0); // did NOT crash
    expect(result.stderr).toContain('Suppressed non-fatal credential-listener error');
  });

  it('a real child process throwing a GENUINE, unrelated error still crashes normally even with the shim loaded', () => {
    const shimPath = writePreviewResilienceShim();
    const result = spawnSync(process.execPath, [
      '-e',
      `throw new Error('TypeError: cannot read property of undefined')`,
    ], {
      env: { ...process.env, NODE_OPTIONS: `--require ${shimPath}` },
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0); // still crashes -- this is not a general error-swallower
  });
});
