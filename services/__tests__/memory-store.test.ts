import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initProjectMemory, getProjectMemory, updateProjectMemory,
  appendConversationTurn, recordVerification,
} from '../memory-store';

/**
 * Level 1 (fast CI) "memory" coverage — proves a project's conversation
 * history, edits, and verification results survive across separate calls
 * (i.e. across a page refresh / re-opened session), using a REAL temp
 * directory rather than a mock: memory-store.ts is already file-based and
 * path-injected, so this is fast and deterministic without needing to fake
 * anything.
 */
describe('memory-store — project memory persistence', () => {
  let projectPath: string;
  beforeEach(async () => { projectPath = await mkdtemp(join(tmpdir(), 'dwomoh-memory-test-')); });
  afterEach(async () => { await rm(projectPath, { recursive: true, force: true }); });

  it('initProjectMemory creates a memory record readable by getProjectMemory', async () => {
    await initProjectMemory({ projectId: 'p1', name: 'Test App', originalPrompt: 'build a test app', projectPath });
    const mem = await getProjectMemory(projectPath);
    expect(mem).not.toBeNull();
    expect(mem?.projectId).toBe('p1');
    expect(mem?.name).toBe('Test App');
    expect(mem?.originalPrompt).toBe('build a test app');
    expect(mem?.conversationHistory).toEqual([]);
  });

  it('getProjectMemory returns null for a project that was never initialized', async () => {
    expect(await getProjectMemory(projectPath)).toBeNull();
  });

  it('appendConversationTurn persists across separate reads (the actual "remember the session" guarantee)', async () => {
    await initProjectMemory({ projectId: 'p1', name: 'Test App', originalPrompt: 'build a test app', projectPath });
    await appendConversationTurn(projectPath, 'user', 'demo login is invalid, fix it');
    await appendConversationTurn(projectPath, 'assistant', 'Fixed — the auth contract was mismatched.');

    const mem = await getProjectMemory(projectPath);
    expect(mem?.conversationHistory).toHaveLength(2);
    expect(mem?.conversationHistory[0]).toMatchObject({ role: 'user', content: 'demo login is invalid, fix it' });
    expect(mem?.conversationHistory[1]).toMatchObject({ role: 'assistant', content: 'Fixed — the auth contract was mismatched.' });
  });

  it('caps conversation history at 40 turns (bounded memory, not unbounded growth)', async () => {
    await initProjectMemory({ projectId: 'p1', name: 'Test App', originalPrompt: 'build a test app', projectPath });
    for (let i = 0; i < 45; i++) await appendConversationTurn(projectPath, 'user', `message ${i}`);
    const mem = await getProjectMemory(projectPath);
    expect(mem?.conversationHistory.length).toBeLessThanOrEqual(41); // 40 previous + 1 just appended, per the slice(-40) + push pattern
    // Most recent message must be the last one sent — old ones are dropped, not new ones.
    expect(mem?.conversationHistory[mem.conversationHistory.length - 1].content).toBe('message 44');
  });

  it('updateProjectMemory merges partial updates without discarding existing fields', async () => {
    await initProjectMemory({ projectId: 'p1', name: 'Test App', originalPrompt: 'build a test app', projectPath });
    await appendConversationTurn(projectPath, 'user', 'hello');
    await updateProjectMemory(projectPath, { buildStatus: 'success', runningPort: 3005 });

    const mem = await getProjectMemory(projectPath);
    expect(mem?.buildStatus).toBe('success');
    expect(mem?.runningPort).toBe(3005);
    expect(mem?.conversationHistory).toHaveLength(1); // untouched by the unrelated update
  });

  it('updateProjectMemory on a never-initialized project is a safe no-op (does not throw or fabricate a record)', async () => {
    await expect(updateProjectMemory(projectPath, { buildStatus: 'success' })).resolves.toBeUndefined();
    expect(await getProjectMemory(projectPath)).toBeNull();
  });

  it('recordVerification appends to verification history for later inspection (Developer Mode / audit trail)', async () => {
    await initProjectMemory({ projectId: 'p1', name: 'Test App', originalPrompt: 'build a test app', projectPath });
    await recordVerification(projectPath, { verified: true, summary: 'All checks passed', checks: [{ passed: true }, { passed: true }] });
    const mem = await getProjectMemory(projectPath);
    expect(mem?.verificationHistory?.length).toBeGreaterThan(0);
  });
});
