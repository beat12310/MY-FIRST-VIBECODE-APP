import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findRegressions, loadBaseline, saveBaseline, type RealRunSummary } from '../real-build-runner';

function run(overrides: Partial<RealRunSummary>): RealRunSummary {
  return {
    prompt: 'build a football prediction app', timestamp: new Date().toISOString(), durationMs: 1000,
    success: true, buildStatus: 'success', verifyStatus: 'passed', repairStatus: 'passed',
    previewStatus: 'available', fileCount: 40, routeCount: 8, remainingInternalIssues: 0,
    summary: 'Complete', ...overrides,
  };
}

describe('findRegressions — Level 2 scheduled real-AI comparison logic', () => {
  it('flags a previously-successful prompt that is no longer successful', () => {
    const baseline = [run({ success: true })];
    const current = [run({ success: false })];
    const findings = findRegressions(baseline, current);
    expect(findings.some(f => f.field === 'success')).toBe(true);
  });

  it('flags verifyStatus regressing from passed to failed', () => {
    const baseline = [run({ verifyStatus: 'passed' })];
    const current = [run({ verifyStatus: 'failed' })];
    const findings = findRegressions(baseline, current);
    expect(findings.some(f => f.field === 'verifyStatus')).toBe(true);
  });

  it('flags previewStatus regressing from available to unavailable', () => {
    const baseline = [run({ previewStatus: 'available' })];
    const current = [run({ previewStatus: 'unavailable' })];
    const findings = findRegressions(baseline, current);
    expect(findings.some(f => f.field === 'previewStatus')).toBe(true);
  });

  it('flags remainingInternalIssues going from zero to non-zero', () => {
    const baseline = [run({ remainingInternalIssues: 0 })];
    const current = [run({ remainingInternalIssues: 3 })];
    const findings = findRegressions(baseline, current);
    expect(findings.some(f => f.field === 'remainingInternalIssues')).toBe(true);
  });

  it('does NOT flag a genuinely identical run', () => {
    const baseline = [run({})];
    const current = [run({})];
    expect(findRegressions(baseline, current)).toHaveLength(0);
  });

  it('does NOT flag natural variance in fileCount/durationMs (not regression signals on their own)', () => {
    const baseline = [run({ fileCount: 40, durationMs: 90_000 })];
    const current = [run({ fileCount: 42, durationMs: 120_000 })];
    expect(findRegressions(baseline, current)).toHaveLength(0);
  });

  it('does NOT flag a prompt with no prior baseline (first-ever run of a new prompt)', () => {
    const baseline: RealRunSummary[] = [];
    const current = [run({ success: false })];
    expect(findRegressions(baseline, current)).toHaveLength(0);
  });

  it('an already-failing prompt that stays failing is not a NEW regression', () => {
    const baseline = [run({ success: false, verifyStatus: 'failed' })];
    const current = [run({ success: false, verifyStatus: 'failed' })];
    expect(findRegressions(baseline, current)).toHaveLength(0);
  });
});

describe('loadBaseline / saveBaseline — round-trip', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dwomoh-baseline-test-')); file = join(dir, 'baseline.json'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('returns an empty array when no baseline file exists yet', async () => {
    expect(await loadBaseline(file)).toEqual([]);
  });

  it('round-trips saved runs exactly', async () => {
    const runs = [run({ prompt: 'a' }), run({ prompt: 'b' })];
    await saveBaseline(file, runs);
    expect(await loadBaseline(file)).toEqual(runs);
  });

  it('returns an empty array for corrupted baseline data rather than throwing', async () => {
    await rm(file, { force: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(file, 'not valid json', 'utf8');
    expect(await loadBaseline(file)).toEqual([]);
  });
});
