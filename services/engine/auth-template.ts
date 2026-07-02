/**
 * Deterministic authentication route + middleware templates — the auth
 * counterpart to crud-template.ts.
 *
 * Root cause this fixes: the AI model was never told the exact shape of
 * lib/managed/auth.ts (injected into every project by project-generator.ts's
 * injectManagedServices), so it invented a different, incompatible API every
 * single time it wrote app/api/auth/{register,login}/route.ts. Confirmed
 * across 5 live-generated apps this session, all broken in different ways:
 *   - `import { auth } from '@/lib/managed/auth'; auth.register(...)` — no
 *     such export exists; `auth` is undefined, throws at runtime (500).
 *   - `import { signIn } from '@/lib/managed/auth'` — also nonexistent.
 *   - A fully fake in-memory login accepting ANY password, no lib/managed
 *     import at all — a real security hole, not just a broken build.
 *   - `import db from '@/lib/managed/db'; db.query('...WHERE email = $1', ...)`
 *     — Postgres-style API/placeholders against a nonexistent `users` table;
 *     the real db.ts is SQLite-backed with `db.get/run/all` and `?` params.
 *   - Even a route that DID import the real functions set a cookie named
 *     `auth_token`, while lib/managed/auth.ts's getAuthUser() only reads a
 *     cookie named `managed_token` — a second, independent mismatch.
 *
 * The real, load-bearing contract (lib/managed/auth.ts, always injected):
 *   registerUser(email, password, name?) -> {id, email, name}
 *     throws Error('Email already registered') on duplicate
 *   loginUser(email, password) -> {token, user}
 *     throws Error('Invalid email or password') on failure
 *   getAuthUser(request: Request) -> {sub, email, role} | null
 *     reads Authorization: Bearer <token>, else a `managed_token` cookie
 *   getUserById(id) -> ManagedUser | undefined
 *
 * Rather than trying to teach the model this contract reliably via prompting
 * (advisory, not enforced — five different wrong guesses proves prompting
 * alone doesn't converge), these four routes + middleware are generated
 * deterministically and injected unconditionally whenever an app has auth,
 * overwriting whatever the model produced at these exact paths. Zero Bedrock
 * cost, zero variance, matches every future app automatically.
 */

import type { RoleGate } from './permissions-template';

export interface AuthFile { filePath: string; content: string }

const COOKIE_OPTS = `{
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    }`;

const REGISTER_ROUTE = `import { NextRequest, NextResponse } from 'next/server';
import { registerUser, loginUser } from '@/lib/managed/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, name } = body;

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    await registerUser(email, password, name || '');
    // Auto-login right after registration so a new account starts with a session,
    // matching the UX every generated signup form expects.
    const { token, user } = await loginUser(email, password);

    const response = NextResponse.json({ user, message: 'Registration successful' }, { status: 201 });
    response.cookies.set('managed_token', token, ${COOKIE_OPTS});
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Registration failed';
    if (message.toLowerCase().includes('already registered') || message.toLowerCase().includes('exist')) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
`;

const LOGIN_ROUTE = `import { NextRequest, NextResponse } from 'next/server';
import { loginUser } from '@/lib/managed/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const { token, user } = await loginUser(email, password);
    const response = NextResponse.json({ user, message: 'Login successful' });
    response.cookies.set('managed_token', token, ${COOKIE_OPTS});
    return response;
  } catch (error: unknown) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }
}
`;

const LOGOUT_ROUTE = `import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ message: 'Logged out' });
  response.cookies.set('managed_token', '', { path: '/', maxAge: 0 });
  return response;
}
`;

const ME_ROUTE = `import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, getUserById } from '@/lib/managed/auth';

export async function GET(req: NextRequest) {
  const payload = await getAuthUser(req);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const user = getUserById(payload.sub);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  return NextResponse.json({ user });
}
`;

/** Route paths + content this template always produces (fixed, not plan-dependent). */
export function buildAuthRoutes(): AuthFile[] {
  return [
    { filePath: 'app/api/auth/register/route.ts', content: REGISTER_ROUTE },
    { filePath: 'app/api/auth/login/route.ts', content: LOGIN_ROUTE },
    { filePath: 'app/api/auth/logout/route.ts', content: LOGOUT_ROUTE },
    { filePath: 'app/api/auth/me/route.ts', content: ME_ROUTE },
  ];
}

// Pages that never require a session — everything else is gated when the app
// has auth. Deliberately broad (better to under-protect a marketing page than
// to lock a real feature route out of a false "public" match).
const PUBLIC_ROUTE_RE = /^\/(login|signup|register|sign-in|sign-up|auth|about|contact|pricing|terms|privacy|blog|faq|help|forgot-password|reset-password)(\/.*)?$/i;

/** Which of a plan's page routes should be gated by middleware. */
export function deriveProtectedRoutes(pageRoutes: string[]): string[] {
  return pageRoutes.filter(r => r !== '/' && !PUBLIC_ROUTE_RE.test(r));
}

/**
 * Server-side route guard. Runs BEFORE any protected page renders, so an
 * unauthenticated GET gets a real redirect instead of a 200 — the app's own
 * client-side `useEffect` + `/api/auth/me` check still runs too (for the
 * signed-in UI state), but is no longer the ONLY thing standing between an
 * anonymous request and a protected page's content.
 *
 * Deliberately checks only cookie PRESENCE, not full JWT verification —
 * lib/managed/auth.ts's verifyToken() transitively imports lib/managed/db.ts
 * (better-sqlite3, a native Node addon), which cannot run in the Edge
 * runtime middleware executes in by default. Full verification still happens
 * server-side in getAuthUser() on every protected page/API call.
 */
/**
 * The single source of truth for turning a route into its middleware.ts
 * regex-pattern SOURCE TEXT. Dynamic segments (`[id]`) become the wildcard
 * `[^/]+`, so — critically — the LITERAL bracket text never appears in a
 * correctly-generated pattern for a dynamic route. Any code that needs to
 * check "does middleware.ts already cover this route" (not just code that
 * WRITES patterns) must go through this function too, or a naive substring
 * check against the raw route will falsely report dynamic routes as
 * uncovered forever — confirmed live: verifier.ts's own detection check did
 * exactly this, causing repair to "fix" /courses/[id] repeatedly and never
 * converge, since it kept re-detecting the same route as still unprotected.
 */
export function routeToPatternSource(route: string): string {
  const escaped = route.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/');
  return `/^${escaped}(\\/.*)?$/`;
}

/**
 * `roleGates` is additive and defaults to empty — every existing call site
 * that doesn't pass it (project-generator.ts, builder.ts, repairer.ts's
 * auth-failure fast-path) gets BYTE-IDENTICAL output to before this
 * parameter existed. Only when an app actually has role-gated sections
 * (services/engine/permissions-template.ts's deriveRoleGates) does the
 * generated middleware.ts grow the extra role-checking scaffolding at all.
 *
 * jose's jwtVerify() (not lib/managed/auth.ts's getAuthUser()/verifyToken())
 * is used to read the role claim directly — getAuthUser() transitively
 * imports lib/managed/db.ts (better-sqlite3, a native Node addon) which
 * cannot run in the Edge runtime middleware executes in by default. jose is
 * Edge-safe and the role claim is already embedded in the JWT payload by
 * loginUser(), so no database lookup is needed just to read it here.
 */
export function buildMiddleware(protectedRoutes: string[], roleGates: RoleGate[] = []): AuthFile {
  const patterns = protectedRoutes.length > 0
    ? protectedRoutes.map(r => `  ${routeToPatternSource(r)}`).join(',\n')
    : '  /^\\/dashboard(\\/.*)?$/';

  const hasRoleGates = roleGates.length > 0;

  const roleImport = hasRoleGates ? `import { jwtVerify } from 'jose';\n` : '';
  const jwtSecretDecl = hasRoleGates ? `
const JWT_SECRET = new TextEncoder().encode(
  process.env.MANAGED_JWT_SECRET || 'dwomoh-change-in-production-' + process.cwd()
);
` : '';
  const rolePatternsDecl = hasRoleGates ? `
const ROLE_PATTERNS: { pattern: RegExp; role: string }[] = [
${roleGates.map(g => `  { pattern: ${routeToPatternSource(g.prefix)}, role: '${g.role}' },\n  { pattern: ${routeToPatternSource('/api' + g.prefix)}, role: '${g.role}' },`).join('\n')}
];
` : '';
  const roleCheckBlock = hasRoleGates ? `

  const roleGate = ROLE_PATTERNS.find((g) => g.pattern.test(pathname));
  if (roleGate) {
    const token = request.cookies.get('managed_token')?.value;
    if (!token) return denyAccess(request, pathname);
    try {
      const { payload } = await jwtVerify(token, JWT_SECRET);
      if (payload.role !== roleGate.role) return denyAccess(request, pathname);
      return NextResponse.next();
    } catch {
      return denyAccess(request, pathname);
    }
  }
` : '';
  const denyAccessFn = hasRoleGates ? `
function denyAccess(request: NextRequest, pathname: string) {
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirect', pathname);
  return NextResponse.redirect(loginUrl);
}
` : '';
  const matcherLine = hasRoleGates
    ? `matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)', ${roleGates.map(g => `'/api${g.prefix}/:path*'`).join(', ')}],`
    : `matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],`;

  const content = `import { NextRequest, NextResponse } from 'next/server';
${roleImport}${jwtSecretDecl}
const PROTECTED_PATTERNS = [
${patterns},
];
${rolePatternsDecl}
export ${hasRoleGates ? 'async ' : ''}function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;${roleCheckBlock}
  const isProtected = PROTECTED_PATTERNS.some((p) => p.test(pathname));
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get('managed_token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}
${denyAccessFn}
export const config = {
  ${matcherLine}
};
`;
  return { filePath: 'middleware.ts', content };
}

/**
 * Deterministically add a route to an EXISTING middleware.ts's PROTECTED_PATTERNS
 * array, rather than relying on the edit model to remember to update it.
 *
 * Root cause this fixes: confirmed live that requesting a new page with
 * auth-implying language ("a /billing page where signed-in users can view
 * and manage...") correctly created the page but never touched middleware.ts
 * — the new page shipped completely unprotected. The edit model was never
 * even told this file existed unless the request happened to also match
 * middleware.ts by name, and even when it's in context, remembering to keep
 * a generated array in sync with a brand-new route is exactly the kind of
 * thing a deterministic patch is more reliable at than a fresh model call.
 *
 * Returns unchanged when middleware.ts doesn't match the expected
 * PROTECTED_PATTERNS shape (e.g. a hand-written or heavily-edited middleware)
 * — this only ever ADDS a pattern to a recognized array, never rewrites
 * unfamiliar content.
 */
export function addProtectedRoute(middlewareContent: string, route: string): { patched: string; changed: boolean } {
  const arrayMatch = middlewareContent.match(/(const PROTECTED_PATTERNS = \[)([\s\S]*?)(\n\];)/);
  if (!arrayMatch) return { patched: middlewareContent, changed: false };

  const patternSource = routeToPatternSource(route);
  if (arrayMatch[2].includes(patternSource)) return { patched: middlewareContent, changed: false };

  const body = arrayMatch[2].replace(/,?\s*$/, '');
  const newBody = `${body},\n  ${patternSource},`;
  const patched = middlewareContent.replace(arrayMatch[0], `${arrayMatch[1]}${newBody}${arrayMatch[3]}`);
  return { patched, changed: true };
}
