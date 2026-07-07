import { describe, it, expect } from 'vitest';
import { buildAuthRoutes, buildAuthPages, buildMiddleware, deriveProtectedRoutes, routeToPatternSource } from '../auth-template';
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
  it('produces exactly the 6 expected auth routes', () => {
    const files = buildAuthRoutes();
    const paths = files.map(f => f.filePath).sort();
    expect(paths).toEqual([
      'app/api/auth/forgot-password/route.ts',
      'app/api/auth/login/route.ts',
      'app/api/auth/logout/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/auth/register/route.ts',
      'app/api/auth/reset-password/route.ts',
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

/**
 * Regression coverage for a real live-production failure: a generated app's
 * own AI-produced login/signup pages (if any) can legitimately live at a
 * different path (e.g. /login) than the canonical /auth/signin,
 * /auth/signup, /auth/forgot-password paths verification and users actually
 * navigate to. Confirmed live: all three 404'd on a generated car sales
 * marketplace even though auth was clearly present. buildAuthPages()
 * guarantees these exact canonical paths always resolve.
 */
describe('auth-template — canonical auth PAGE routes (closes the /auth/signin 404 gap)', () => {
  it('produces exactly the 3 expected canonical page paths', () => {
    const files = buildAuthPages();
    const paths = files.map(f => f.filePath).sort();
    expect(paths).toEqual([
      'app/auth/forgot-password/page.tsx',
      'app/auth/signin/page.tsx',
      'app/auth/signup/page.tsx',
    ]);
  });

  it('signin page posts to /api/auth/login', () => {
    const signin = buildAuthPages().find(f => f.filePath === 'app/auth/signin/page.tsx')!;
    expect(signin.content).toContain("/api/auth/login");
  });

  it('signup page posts to /api/auth/register', () => {
    const signup = buildAuthPages().find(f => f.filePath === 'app/auth/signup/page.tsx')!;
    expect(signup.content).toContain("/api/auth/register");
  });

  it('forgot-password page wires both forgot-password and reset-password API calls', () => {
    const forgot = buildAuthPages().find(f => f.filePath === 'app/auth/forgot-password/page.tsx')!;
    expect(forgot.content).toContain("/api/auth/forgot-password");
    expect(forgot.content).toContain("/api/auth/reset-password");
  });

  it('the canonical /auth/* pages are treated as public (not gated) by the auth middleware', () => {
    const protectedRoutes = deriveProtectedRoutes(['/', '/dashboard', '/auth/signin', '/auth/signup', '/auth/forgot-password']);
    expect(protectedRoutes).toEqual(['/dashboard']);
  });
});

describe('auth-template — forgot-password / reset-password API routes', () => {
  it('forgot-password route uses the already-injected createOTP + sendPasswordResetEmail contract', () => {
    const route = buildAuthRoutes().find(f => f.filePath === 'app/api/auth/forgot-password/route.ts')!;
    expect(route.content).toContain("from '@/lib/managed/auth'");
    expect(route.content).toContain('createOTP');
    expect(route.content).toContain("from '@/lib/managed/email'");
    expect(route.content).toContain('sendPasswordResetEmail');
  });

  it('forgot-password route does not leak whether an email is registered (same response either way)', () => {
    const route = buildAuthRoutes().find(f => f.filePath === 'app/api/auth/forgot-password/route.ts')!;
    // Only one NextResponse.json success path outside the 400 validation branch.
    const successResponses = route.content.match(/NextResponse\.json\(\{ message:/g) ?? [];
    expect(successResponses.length).toBe(1);
  });

  it('reset-password route verifies the OTP before updating the password hash', () => {
    const route = buildAuthRoutes().find(f => f.filePath === 'app/api/auth/reset-password/route.ts')!;
    expect(route.content).toContain('verifyOTP');
    expect(route.content).toContain('hashPassword');
    expect(route.content).toContain('UPDATE managed_users SET password_hash');
    // Verification must happen before the DB write, not after.
    expect(route.content.indexOf('verifyOTP')).toBeLessThan(route.content.indexOf('UPDATE managed_users'));
  });
});
