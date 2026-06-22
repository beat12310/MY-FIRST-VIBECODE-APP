/**
 * GET /api/build-history
 * Returns JSONL events scoped to the authenticated user.
 * Events are stored in /tmp/dwomoh-vibecode-events/ and optionally tagged with ownerUserId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getAuthUser } from '@/lib/server-auth';
import { listProjects } from '@/services/project-store';

const EVENTS_DIR = '/tmp/dwomoh-vibecode-events';

export async function GET(request: NextRequest) {
  const authUser = await getAuthUser(request);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Build a set of project paths the user owns — used to filter legacy events
  const userProjects = await listProjects(authUser.sub);
  const userProjectPaths = new Set(userProjects.map(p => p.projectPath));
  const userProjectNames = new Set(userProjects.map(p => p.name));

  try {
    const files = await readdir(EVENTS_DIR).catch(() => [] as string[]);
    const events: object[] = [];

    for (const file of files.filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 10)) {
      const raw = await readFile(join(EVENTS_DIR, file), 'utf-8').catch(() => '');
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          // Accept events explicitly tagged to this user
          if (event.ownerUserId && event.ownerUserId === authUser.sub) {
            events.push(event);
          }
          // Accept events that match a project owned by this user (for legacy events)
          else if (!event.ownerUserId) {
            const name = (event.projectName ?? event.name ?? '') as string;
            const path = (event.projectPath ?? '') as string;
            if (userProjectNames.has(name) || (path && userProjectPaths.has(path))) {
              events.push(event);
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    return NextResponse.json({ events: events.slice(0, 100) });
  } catch {
    return NextResponse.json({ events: [] });
  }
}
