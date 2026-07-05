import { describe, it, expect } from 'vitest';
import { buildIsolatedDevServerEnv } from '../project-runner';

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

  it('defaults to the real process.env when no source is provided', () => {
    const env = buildIsolatedDevServerEnv();
    expect(env.NODE_ENV).toBe('development');
    expect(typeof env).toBe('object');
  });
});
