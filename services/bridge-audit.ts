/**
 * Append-only audit log for Claude Code bridge sessions.
 * Every session — successful or not — is recorded here.
 * Stored as newline-delimited JSON in generated-projects/.bridge-audit.jsonl
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { PROJECT_CONFIG } from '@/lib/constants';

const AUDIT_FILE = join(
  process.cwd(),
  PROJECT_CONFIG.GENERATED_PROJECTS_DIR,
  '.bridge-audit.jsonl',
);

export interface BridgeAuditEntry {
  sessionId: string;
  userId: string;
  userEmail?: string;
  projectId: string;
  projectPath: string;
  startedAt: string;
  completedAt?: string;
  promptPreview: string;       // first 120 chars of the prompt
  promptLength: number;
  policyBlocked: boolean;
  policyBlockReason?: string;
  autoEscalated: boolean;      // true when triggered by the repair loop, false when manual
  escalationReason?: string;   // what stuck state triggered auto-escalation
  exitCode?: number;
  changedFiles: string[];
  verifyResult?: { verified: boolean; summary: string; passedCount: number; totalCount: number };
  rollbackOccurred: boolean;
  rollbackSucceeded?: boolean;
  error?: string;
}

async function write(entry: Partial<BridgeAuditEntry> & { event: string }): Promise<void> {
  try {
    await mkdir(join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR), { recursive: true });
    await appendFile(AUDIT_FILE, JSON.stringify({ ...entry, _ts: new Date().toISOString() }) + '\n', 'utf-8');
  } catch {
    // Never let audit failure break the bridge
  }
}

export async function auditBridgeStart(entry: Omit<BridgeAuditEntry, 'completedAt' | 'changedFiles' | 'rollbackOccurred'>): Promise<void> {
  await write({ ...entry, changedFiles: [], rollbackOccurred: false, event: 'start' });
}

export async function auditBridgeComplete(sessionId: string, update: Partial<BridgeAuditEntry>): Promise<void> {
  await write({ sessionId, ...update, completedAt: new Date().toISOString(), event: 'complete' });
}
