import { describe, it, expect, afterAll } from 'vitest';
import { getPermissionsForRole, getRole, setRole, hasPermission, type Role } from '../rbac';

describe('rbac — ROLE_PERMISSIONS mapping (built 2026-06)', () => {
  // The one place role→capability decisions live. This table is exactly
  // what the platform's billing/subscription/deploy gates and Developer
  // Mode UI trust — a regression here (e.g. USER accidentally gaining a
  // BYPASS permission, or SUPER_ADMIN losing one) would silently break
  // either billing enforcement or the owner's own access.
  it('USER has no bypass or elevated permissions', () => {
    const perms = getPermissionsForRole('USER');
    expect(perms.size).toBe(0);
  });

  it('SUPER_ADMIN has every bypass and elevated permission', () => {
    const perms = getPermissionsForRole('SUPER_ADMIN');
    expect(perms.has('BYPASS_CREDITS')).toBe(true);
    expect(perms.has('BYPASS_BILLING')).toBe(true);
    expect(perms.has('BYPASS_SUBSCRIPTION')).toBe(true);
    expect(perms.has('BYPASS_DEPLOY_LIMITS')).toBe(true);
    expect(perms.has('BYPASS_STORAGE_LIMITS')).toBe(true);
    expect(perms.has('BYPASS_PROJECT_LIMITS')).toBe(true);
    expect(perms.has('VIEW_DEVELOPER_MODE')).toBe(true);
    expect(perms.has('MANAGE_ROLES')).toBe(true);
  });

  it('ADMIN can manage roles and view Developer Mode but has no billing bypass', () => {
    const perms = getPermissionsForRole('ADMIN');
    expect(perms.has('MANAGE_ROLES')).toBe(true);
    expect(perms.has('VIEW_DEVELOPER_MODE')).toBe(true);
    expect(perms.has('BYPASS_CREDITS')).toBe(false);
    expect(perms.has('BYPASS_BILLING')).toBe(false);
  });

  it('SUPPORT and QA_TESTER can view Developer Mode but cannot manage roles or bypass billing', () => {
    for (const role of ['SUPPORT', 'QA_TESTER'] as Role[]) {
      const perms = getPermissionsForRole(role);
      expect(perms.has('VIEW_DEVELOPER_MODE')).toBe(true);
      expect(perms.has('MANAGE_ROLES')).toBe(false);
      expect(perms.has('BYPASS_CREDITS')).toBe(false);
    }
  });

  it('MODERATOR and BETA_TESTER have no elevated permissions at all', () => {
    for (const role of ['MODERATOR', 'BETA_TESTER'] as Role[]) {
      expect(getPermissionsForRole(role).size).toBe(0);
    }
  });
});

describe('rbac — getRole/setRole/hasPermission round-trip (fail-safe behavior)', () => {
  // Uses a clearly test-scoped, never-real userId so this can't collide with
  // any real seeded account. setRole/getRole persist to the shared local
  // dev store (services/billing-store.ts's .billing-data/store.json when
  // BILLING_TABLE isn't set), so the test cleans up after itself.
  const TEST_USER = '__vitest_rbac_test_user__';

  afterAll(async () => {
    // Reset back to the implicit default rather than leaving a stray
    // elevated-role record for this synthetic user in the shared dev store.
    await setRole(TEST_USER, 'USER', 'test-cleanup');
  });

  it('an unknown user defaults to USER with no permissions', async () => {
    const role = await getRole('__vitest_rbac_never_set_user__');
    expect(role).toBe('USER');
    expect(await hasPermission('__vitest_rbac_never_set_user__', 'BYPASS_CREDITS')).toBe(false);
  });

  it('setRole persists and getRole/hasPermission reflect it', async () => {
    await setRole(TEST_USER, 'SUPER_ADMIN', 'test-suite');
    expect(await getRole(TEST_USER)).toBe('SUPER_ADMIN');
    expect(await hasPermission(TEST_USER, 'BYPASS_CREDITS')).toBe(true);
    expect(await hasPermission(TEST_USER, 'VIEW_DEVELOPER_MODE')).toBe(true);
  });
});
