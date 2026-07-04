/**
 * GET /api/admin/roles — returns the caller's own role + permission set.
 * Used by the client to decide whether to render Developer Mode UI at all.
 *
 * POST /api/admin/roles { targetUserId, role } — assigns a role to another
 * account. Gated EXCLUSIVELY by hasPermission(caller, 'MANAGE_ROLES') — no
 * ADMIN_EMAILS or other env-var/email fallback, per explicit requirement
 * that role authorization must be fully database-driven. The very first
 * SUPER_ADMIN is seeded by a one-time, developer-run script directly against
 * services/rbac.ts's setRole() (not through this route) — after that single
 * seed, every further role grant (including to ADMIN/SUPPORT/MODERATOR/
 * QA_TESTER/BETA_TESTER accounts) goes through this route, gated by the
 * now-established SUPER_ADMIN/ADMIN role.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/server-auth';
import { getRole, setRole, hasPermission, getPermissionsForRole, type Role } from '@/services/rbac';

const VALID_ROLES: Role[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'MODERATOR', 'QA_TESTER', 'BETA_TESTER', 'USER'];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser(req);
  if (!user?.sub) {
    console.log('[api/admin/roles] GET — no authenticated user resolved from request (missing/invalid Authorization header)');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const role = await getRole(user.sub);
  const permissions = [...getPermissionsForRole(role)];
  console.log(`[api/admin/roles] GET — sub=${user.sub} email=${user.email ?? '(none)'} role=${role} permissions=[${permissions.join(',')}]`);
  return NextResponse.json({ role, permissions });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser(req);
  if (!user?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!(await hasPermission(user.sub, 'MANAGE_ROLES'))) {
    return NextResponse.json({ error: 'Forbidden — requires MANAGE_ROLES permission' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { targetUserId?: string; role?: string } | null;
  const targetUserId = body?.targetUserId?.trim();
  const role = body?.role as Role | undefined;

  if (!targetUserId) return NextResponse.json({ error: 'Missing targetUserId' }, { status: 400 });
  if (!role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }

  await setRole(targetUserId, role, user.sub);
  return NextResponse.json({ success: true, targetUserId, role, grantedBy: user.sub });
}
