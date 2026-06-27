/**
 * GET  /api/deploy-live/history  → full deployment history
 * DELETE /api/deploy-live/history → clear history
 */

import { NextRequest } from 'next/server';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const HISTORY_FILE = join(process.cwd(), '.dwomoh', 'deployment-history.json');

export async function GET() {
  try {
    const history = existsSync(HISTORY_FILE)
      ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
      : [];
    return Response.json({ history, count: history.length });
  } catch {
    return Response.json({ history: [], count: 0 });
  }
}

export async function DELETE() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
    return Response.json({ cleared: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
