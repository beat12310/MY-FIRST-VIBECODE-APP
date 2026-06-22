import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server-auth';
import { listProjects } from '@/services/project-store';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;

  const projects = await listProjects(auth.user.sub);
  return NextResponse.json({ projects });
}
