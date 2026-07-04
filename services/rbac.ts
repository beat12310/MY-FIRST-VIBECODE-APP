/**
 * Role-based access control. Every authorization decision is permission-based
 * (hasPermission), never a direct role-name check — this is the one place
 * role→capability mappings live, so adding/adjusting a role's access later
 * means editing ROLE_PERMISSIONS, not any gate-check call site.
 *
 * Storage follows the same pattern as services/credit-wallet.ts: a role
 * record lives at the same USER#<sub> pk every other billing-adjacent record
 * (wallet, subscription, domain orders) uses, via services/billing-store.ts's
 * shared getItem/putItem primitives — same DynamoDB-in-prod / local-JSON-in-
 * dev storage, no new infra.
 *
 * Fail-safe direction is deliberately the OPPOSITE of the credit gates: on
 * any store error, getRole/hasPermission fall back to the lowest privilege
 * ('USER' / false), never a bypass. A billing-store outage must never
 * accidentally grant elevated access.
 */
import { getItem, putItem } from './billing-store';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT' | 'MODERATOR' | 'QA_TESTER' | 'BETA_TESTER' | 'USER';

export type Permission =
  | 'BYPASS_CREDITS'
  | 'BYPASS_BILLING'
  | 'BYPASS_SUBSCRIPTION'
  | 'BYPASS_DEPLOY_LIMITS'
  | 'BYPASS_STORAGE_LIMITS'
  | 'BYPASS_PROJECT_LIMITS'
  | 'VIEW_DEVELOPER_MODE'
  | 'MANAGE_ROLES';

export interface RoleRecord { pk: string; sk: 'ROLE'; userId: string; role: Role; grantedBy?: string; updatedAt: string; [k: string]: unknown; }

const userPk = (u: string) => `USER#${u}`;

// The one place role→capability decisions live. Changing what a role can do
// means editing this table, never any gate-check call site.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set<Permission>([
    'BYPASS_CREDITS', 'BYPASS_BILLING', 'BYPASS_SUBSCRIPTION',
    'BYPASS_DEPLOY_LIMITS', 'BYPASS_STORAGE_LIMITS', 'BYPASS_PROJECT_LIMITS',
    'VIEW_DEVELOPER_MODE', 'MANAGE_ROLES',
  ]),
  ADMIN: new Set<Permission>(['VIEW_DEVELOPER_MODE', 'MANAGE_ROLES']),
  SUPPORT: new Set<Permission>(['VIEW_DEVELOPER_MODE']),
  MODERATOR: new Set<Permission>([]),
  QA_TESTER: new Set<Permission>(['VIEW_DEVELOPER_MODE']),
  BETA_TESTER: new Set<Permission>([]),
  USER: new Set<Permission>([]),
};

export async function getRole(userId: string): Promise<Role> {
  try {
    const r = await getItem(userPk(userId), 'ROLE') as RoleRecord | null;
    return r?.role ?? 'USER';
  } catch (e) {
    console.warn('[rbac] getRole failed, defaulting to USER (fail-safe, not fail-open):', e instanceof Error ? e.message : e);
    return 'USER';
  }
}

export async function setRole(userId: string, role: Role, grantedBy?: string): Promise<void> {
  await putItem({
    pk: userPk(userId), sk: 'ROLE', userId, role, grantedBy, updatedAt: new Date().toISOString(),
  } as RoleRecord);
}

export function getPermissionsForRole(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export async function getPermissions(userId: string): Promise<ReadonlySet<Permission>> {
  return getPermissionsForRole(await getRole(userId));
}

export async function hasPermission(userId: string, perm: Permission): Promise<boolean> {
  try {
    return (await getPermissions(userId)).has(perm);
  } catch (e) {
    console.warn('[rbac] hasPermission failed, defaulting to false (fail-safe, not fail-open):', e instanceof Error ? e.message : e);
    return false;
  }
}
