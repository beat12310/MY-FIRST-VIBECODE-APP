import { describe, it, expect } from 'vitest';
import { buildAuthRoutes, buildMiddleware, deriveProtectedRoutes, routeToPatternSource } from '../auth-template';
import { buildCrudRoute, isStandardCrudRoute } from '../crud-template';
import type { PlannedApiRoute, PlannedDataModel } from '../types';

/**
 * Level 1 (fast CI) "authentication tests" / "API tests" — deterministic
 * templates, not live requests, but this IS what determines whether a
 * generated app's auth/CRUD contract is internally consistent: these two
 * templates are the actual mechanism that prevents the "model hallucinates
 * an incompatible lib/managed/auth.ts contract" class of bug documented in
 * auth-template.ts's own header, and the equivalent for standard CRUD
 * routes.
 */
describe('auth-template — generated auth contract correctness', () => {
  it('produces exactly the 4 expected auth routes', () => {
    const files = buildAuthRoutes();
    const paths = files.map(f => f.filePath).sort();
    expect(paths).toEqual([
      'app/api/auth/login/route.ts',
      'app/api/auth/logout/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/auth/register/route.ts',
    ]);
  });

  it('register/login/me import from the SAME lib/managed/auth contract (registerUser/loginUser/etc.) — the exact mismatch class the Prisma incident exposed', () => {
    // logout is excluded on purpose — it only clears the session cookie
    // directly and has no need to import the auth contract at all.
    const files = buildAuthRoutes();
    for (const f of files.filter(f => !f.filePath.includes('logout'))) {
      expect(f.content).toContain("from '@/lib/managed/auth'");
    }
    const register = files.find(f => f.filePath.includes('register'))!;
    const login = files.find(f => f.filePath.includes('login'))!;
    expect(register.content).toContain('registerUser');
    expect(login.content).toContain('loginUser');
  });

  it('deriveProtectedRoutes excludes public-facing pages (login/signup/pricing/etc.) but protects everything else', () => {
    const routes = ['/', '/login', '/signup', '/pricing', '/dashboard', '/orders', '/profile'];
    const protectedRoutes = deriveProtectedRoutes(routes);
    expect(protectedRoutes).not.toContain('/');
    expect(protectedRoutes).not.toContain('/login');
    expect(protectedRoutes).not.toContain('/signup');
    expect(protectedRoutes).not.toContain('/pricing');
    expect(protectedRoutes).toContain('/dashboard');
    expect(protectedRoutes).toContain('/orders');
    expect(protectedRoutes).toContain('/profile');
  });

  it('routeToPatternSource turns a dynamic [id] segment into a wildcard, never a literal bracket', () => {
    const pattern = routeToPatternSource('/orders/[id]');
    expect(pattern).not.toContain('[id]');
    // The slash inside the character class is escaped in the generated
    // source text ('\/'), matching the rest of the pattern's escaping.
    expect(pattern).toContain('[^\\/]+');
  });

  it('buildMiddleware protects every derived route and none of the excluded public ones', () => {
    const middleware = buildMiddleware(['/dashboard', '/orders']);
    expect(middleware.filePath).toBe('middleware.ts');
    expect(middleware.content).toContain('/dashboard');
    expect(middleware.content).toContain('/orders');
  });

  it('buildMiddleware with no protected routes still produces a safe default (never an empty, unprotected matcher)', () => {
    const middleware = buildMiddleware([]);
    expect(middleware.content).toContain('/dashboard');
  });
});

describe('crud-template — generated CRUD API contract correctness', () => {
  const orderModel: PlannedDataModel = { name: 'Order', fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }] };

  it('recognizes a standard list route (GET+POST, no [id])', () => {
    const listRoute: PlannedApiRoute = { route: '/api/orders', filePath: 'app/api/orders/route.ts', methods: ['GET', 'POST'], purpose: 'list/create orders' };
    expect(isStandardCrudRoute(listRoute)).toBe(true);
  });

  it('recognizes a standard detail route (GET+PUT+DELETE, with [id])', () => {
    const detailRoute: PlannedApiRoute = { route: '/api/orders/[id]', filePath: 'app/api/orders/[id]/route.ts', methods: ['GET', 'PUT', 'DELETE'], purpose: 'get/update/delete one order' };
    expect(isStandardCrudRoute(detailRoute)).toBe(true);
  });

  it('does not misclassify a non-standard route shape as CRUD', () => {
    const weirdRoute: PlannedApiRoute = { route: '/api/orders/export', filePath: 'app/api/orders/export/route.ts', methods: ['GET'], purpose: 'export orders as CSV' };
    expect(isStandardCrudRoute(weirdRoute)).toBe(false);
  });

  it('buildCrudRoute produces a working route referencing the managed db contract, for a real data model', () => {
    const listRoute: PlannedApiRoute = { route: '/api/orders', filePath: 'app/api/orders/route.ts', methods: ['GET', 'POST'], purpose: 'list/create orders' };
    const crud = buildCrudRoute(listRoute, [orderModel]);
    expect(crud).not.toBeNull();
    expect(crud!.content).toContain("from '@/lib/managed/db'");
    expect(crud!.content).toContain('initTable');
  });

  it('buildCrudRoute returns null for a non-standard route (never fabricates a wrong CRUD handler)', () => {
    const weirdRoute: PlannedApiRoute = { route: '/api/orders/export', filePath: 'app/api/orders/export/route.ts', methods: ['GET'], purpose: 'export orders as CSV' };
    expect(buildCrudRoute(weirdRoute, [orderModel])).toBeNull();
  });
});
