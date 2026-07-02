/**
 * Deterministic role-based permission gating — an additive extension of
 * auth-template.ts's binary "requires ANY authenticated session" middleware
 * into "requires a SPECIFIC role."
 *
 * Root cause this addresses: lib/managed/auth.ts already tracks a `role`
 * column on every user and embeds it in the JWT payload
 * (`SignJWT({ sub, email, role })`), but nothing in the generated app ever
 * ENFORCES it — any authenticated user can reach an "admin" page or API
 * exactly as easily as a "user" one. Enforcement has always been left
 * entirely to the model (if it remembers to check `user.role === 'admin'`
 * inside a page/route at all).
 *
 * Role NAMES are inherently app-specific data (an event platform might need
 * Admin/Worker/Promoter; a marketplace might need Admin/Vendor/Customer) —
 * unlike "does this route need auth at all" (answerable by excluding a
 * small, universal set of public-page names), there's no way to invent
 * "Promoter" from a generic rule. What CAN be fully deterministic is
 * DISCOVERING which routes are role-gated once the app's own route
 * structure reveals it, and ENFORCING that gate reliably — the same
 * "deterministic once you know the shape" split already used everywhere in
 * this engine (deriveProtectedRoutes doesn't invent which pages need auth
 * out of thin air either; it applies a fixed rule to whatever pages exist).
 *
 * Discovery rule: a top-level route segment that matches a curated,
 * extensible list of role-like words is treated as a role gate for every
 * page AND API route nested under it — e.g. app/admin/dashboard/page.tsx
 * and app/api/admin/users/route.ts both require role 'admin'. This list is
 * intentionally a plain, editable array (matching NON_RESOURCE_SEGMENT and
 * NAV_EXCLUDE_RE elsewhere in this engine) so a future domain's role name
 * can be added in one line, not a design change.
 */

export interface RoleGate { prefix: string; role: string }

export const ROLE_WORDS = [
  'admin', 'superadmin', 'worker', 'staff', 'employee', 'moderator',
  'manager', 'vendor', 'seller', 'owner', 'promoter', 'organizer', 'provider',
];

export function isRoleWord(segment: string): boolean {
  return ROLE_WORDS.includes(segment.toLowerCase());
}

/**
 * Derives one role gate per distinct role-like top-level segment found
 * across a plan's page routes and API routes. For API routes, the "/api"
 * prefix is skipped before checking the role word, so `/api/admin/users`
 * is correctly attributed to the `admin` gate rather than treating `api`
 * itself as a role.
 */
export function deriveRoleGates(pageRoutes: string[], apiRoutes: string[]): RoleGate[] {
  const gates = new Map<string, RoleGate>();
  for (const route of pageRoutes) {
    const first = route.split('/').filter(Boolean)[0];
    if (first && isRoleWord(first)) {
      const role = first.toLowerCase();
      gates.set(role, { prefix: `/${first}`, role });
    }
  }
  for (const route of apiRoutes) {
    const segs = route.split('/').filter(Boolean);
    const first = segs[0] === 'api' ? segs[1] : segs[0];
    if (first && isRoleWord(first)) {
      const role = first.toLowerCase();
      if (!gates.has(role)) gates.set(role, { prefix: `/${first}`, role });
    }
  }
  return [...gates.values()];
}
