import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/server-auth';
import { listProjects } from '@/services/project-store';

export async function GET(request: NextRequest) {
  const authUser = await getAuthUser(request);
  // Allow unauthenticated access — anonymous + disk-discovered projects are included
  const ownerId = authUser?.sub ?? 'anonymous';
  const projects = await listProjects(ownerId);
  return NextResponse.json({ projects });
}
