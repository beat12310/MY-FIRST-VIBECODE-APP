/**
 * Auth Flow Verifier
 *
 * Tests the complete authentication loop against a running Next.js dev server:
 *   1. Register a test account (POST /api/auth/register or /api/auth/signup)
 *   2. Login with those credentials (POST /api/auth/login or /api/auth/signin)
 *   3. Verify session — GET /api/auth/me (or equivalent) WITH the cookie
 *   4. Access a protected page — GET /dashboard (or /profile) WITH the cookie
 *
 * Returns structured VerificationCheck-compatible results for every step so the
 * repair loop can classify and fix each failure independently.
 *
 * Field-name detection: reads the actual API route source to find what fields
 * the handler extracts (email/username, password, name/fullName, etc.) and uses
 * those exact field names in the test POST body — avoiding 400 "missing field" errors.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthFlowStep {
  label: string;
  url: string;
  method: 'GET' | 'POST';
  /** True when this step is required for the auth flow to succeed */
  required: boolean;
  passed: boolean;
  statusCode?: number;
  /** Cookie returned (stored for subsequent steps) */
  sessionCookie?: string;
  error?: string;
  /** Exact JSON body we sent */
  requestBody?: string;
  /** Response body we got back */
  responseBody?: string;
  /** Specific fix hint for the repair engine */
  fixHint?: string;
  fixFile?: string;
}

export interface AuthFlowResult {
  /** Overall result: true only when register AND login both pass */
  passed: boolean;
  steps: AuthFlowStep[];
  /** Concise summary for the chat UI */
  summary: string;
  /** Fields we detected from the API source */
  detectedFields: { emailField: string; passwordField: string; nameField: string };
}

// ─── Known auth endpoint variants ─────────────────────────────────────────────

const REGISTER_CANDIDATES = [
  '/api/auth/register',
  '/api/auth/signup',
  '/api/auth/sign-up',
  '/api/register',
  '/api/signup',
  '/api/users',           // some apps use POST /api/users to create
];

const LOGIN_CANDIDATES = [
  '/api/auth/login',
  '/api/auth/signin',
  '/api/auth/sign-in',
  '/api/login',
  '/api/signin',
];

const ME_CANDIDATES = [
  '/api/auth/me',
  '/api/auth/user',
  '/api/auth/session',
  '/api/me',
  '/api/user',
  '/api/profile',
  '/api/auth/check',
  '/api/auth/status',
];

const PROTECTED_PAGE_CANDIDATES = [
  '/dashboard',
  '/home',
  '/profile',
  '/account',
  '/app',
  '/admin',
  '/feed',
  '/inbox',
];

// ─── Source field detection ───────────────────────────────────────────────────

interface FieldNames {
  emailField: string;
  passwordField: string;
  nameField: string;
}

/**
 * Read the API route source and detect what field names it reads from the request body.
 * Falls back to standard names if detection fails.
 */
async function detectFieldNames(
  projectPath: string,
  routeRelPath: string,
): Promise<FieldNames> {
  const defaults: FieldNames = { emailField: 'email', passwordField: 'password', nameField: 'name' };
  try {
    const src = await readFile(join(projectPath, routeRelPath), 'utf-8');

    // Extract field names from destructuring patterns like:
    //   const { email, password, name } = await req.json()
    //   const { username, pass } = body
    //   body.emailAddress  → emailAddress
    const destructureMatch = src.match(
      /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*(?:await\s+)?(?:req|request|body)(?:\.json\(\))?/
    );
    if (destructureMatch) {
      const fields = destructureMatch[1].split(',').map(f => f.trim().split(/\s*[:=]\s*/)[0].trim());
      // Pick the most likely email field
      const emailField = fields.find(f => /email|username|user|account/i.test(f)) ?? defaults.emailField;
      const passwordField = fields.find(f => /pass(?:word)?|pwd|secret/i.test(f)) ?? defaults.passwordField;
      const nameField = fields.find(f => /^name$|fullname|full_name|displayname/i.test(f)) ?? defaults.nameField;
      return { emailField, passwordField, nameField };
    }

    // Fallback: look for body.xxx or json.xxx patterns
    const bodyAccessMatch = src.match(/(?:body|json|data)\.(\w+)/g);
    if (bodyAccessMatch) {
      const accessedFields = bodyAccessMatch.map(m => m.split('.')[1]);
      const emailField = accessedFields.find(f => /email|username/i.test(f)) ?? defaults.emailField;
      const passwordField = accessedFields.find(f => /pass|pwd/i.test(f)) ?? defaults.passwordField;
      const nameField = accessedFields.find(f => /^name$|fullname/i.test(f)) ?? defaults.nameField;
      return { emailField, passwordField, nameField };
    }
  } catch { /* file missing */ }
  return defaults;
}

// ─── HTTP probe helpers ───────────────────────────────────────────────────────

async function probeEndpoint(
  base: string,
  candidates: string[],
): Promise<{ url: string; exists: boolean }> {
  for (const path of candidates) {
    const url = `${base}${path}`;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      // 405 means route exists but wrong method; 400/401/422 means route exists
      // 404 means route does not exist at this path
      if (res.status !== 404) return { url, exists: true };
    } catch { /* timeout or network error */ }
  }
  return { url: `${base}${candidates[0]}`, exists: false };
}

async function probePage(
  base: string,
  candidates: string[],
  cookie?: string,
): Promise<{ url: string; exists: boolean; status: number }> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  for (const path of candidates) {
    const url = `${base}${path}`;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers, redirect: 'manual' });
      // 200, 307, 302, 303 all mean "route exists"
      if (res.status !== 404) return { url, exists: true, status: res.status };
    } catch { /* timeout */ }
  }
  return { url: `${base}${candidates[0]}`, exists: false, status: 404 };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function verifyAuthFlow(
  port: number,
  projectPath: string,
): Promise<AuthFlowResult> {
  const base = `http://localhost:${port}`;
  const steps: AuthFlowStep[] = [];
  let sessionCookie = '';

  // ── Discover endpoints ─────────────────────────────────────────────────────
  const { url: registerUrl } = await probeEndpoint(base, REGISTER_CANDIDATES);
  const { url: loginUrl } = await probeEndpoint(base, LOGIN_CANDIDATES);

  const registerRelPath = registerUrl.replace(base, '').replace(/^\/api/, 'app/api') + '/route.ts';
  const loginRelPath = loginUrl.replace(base, '').replace(/^\/api/, 'app/api') + '/route.ts';

  // Detect field names from the register route (best signal)
  const fields = await detectFieldNames(projectPath, registerRelPath)
    .catch(() => ({ emailField: 'email', passwordField: 'password', nameField: 'name' }));

  const testEmail = `verify_${Date.now()}@dwomoh.dev`;
  const testPassword = 'VibeCode#Test1!';
  const testName = 'Verification Bot';

  const registerBody: Record<string, string> = {
    [fields.emailField]: testEmail,
    [fields.passwordField]: testPassword,
    [fields.nameField]: testName,
  };

  // ── Step 1: Register ───────────────────────────────────────────────────────
  let registerPassed = false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(registerUrl, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerBody),
    });
    const bodyText = await res.text().catch(() => '');
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0]; // keep only name=value
    }
    registerPassed = res.ok;
    steps.push({
      label: 'Register (POST)',
      url: registerUrl,
      method: 'POST',
      required: true,
      passed: registerPassed,
      statusCode: res.status,
      requestBody: JSON.stringify(registerBody),
      responseBody: bodyText.slice(0, 500),
      sessionCookie: cookieHeader ?? undefined,
      error: registerPassed ? undefined : `HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
      fixHint: !registerPassed && res.status === 400
        ? `The register route returned 400. Check that the API reads these exact field names from req.json(): ${Object.keys(registerBody).join(', ')}. The route must destructure exactly these names.`
        : !registerPassed && res.status === 500
        ? 'Register route crashed with 500 — check that initTable() is called, bcrypt is imported correctly, and the users table schema matches the INSERT statement.'
        : undefined,
      fixFile: registerRelPath.startsWith('app/') ? registerRelPath : undefined,
    });
  } catch (err) {
    steps.push({
      label: 'Register (POST)',
      url: registerUrl,
      method: 'POST',
      required: true,
      passed: false,
      error: err instanceof Error ? err.message : 'Network error',
      requestBody: JSON.stringify(registerBody),
      fixHint: 'Register endpoint did not respond. Ensure the route file exists at the discovered path.',
    });
  }

  // ── Step 2: Login ──────────────────────────────────────────────────────────
  const loginBody: Record<string, string> = {
    [fields.emailField]: testEmail,
    [fields.passwordField]: testPassword,
  };

  // Detect login field names separately (may differ from register)
  const loginFields = await detectFieldNames(projectPath, loginRelPath).catch(() => fields);
  loginBody[loginFields.emailField] = testEmail;
  loginBody[loginFields.passwordField] = testPassword;

  let loginPassed = false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(loginUrl, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBody),
    });
    const bodyText = await res.text().catch(() => '');
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    } else if (!sessionCookie) {
      // Try to extract token from JSON body
      try {
        const json = JSON.parse(bodyText);
        if (json.token) sessionCookie = `managed_token=${json.token}`;
        else if (json.accessToken) sessionCookie = `managed_token=${json.accessToken}`;
      } catch { /* not JSON */ }
    }
    loginPassed = res.ok;
    steps.push({
      label: 'Login (POST)',
      url: loginUrl,
      method: 'POST',
      required: true,
      passed: loginPassed,
      statusCode: res.status,
      requestBody: JSON.stringify(loginBody),
      responseBody: bodyText.slice(0, 500),
      sessionCookie: cookieHeader ?? undefined,
      error: loginPassed ? undefined : `HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
      fixHint: !loginPassed && res.status === 400
        ? `Login route returned 400. Ensure the route reads exactly: { ${loginFields.emailField}, ${loginFields.passwordField} } from req.json(). Also ensure the response sets: response.cookies.set('managed_token', token, { httpOnly: true, path: '/', maxAge: 604800 })`
        : !loginPassed && res.status === 401
        ? 'Login returned 401. If register succeeded, this means the password comparison is failing. Check that bcrypt.compare() is used and that the stored hash was created by bcrypt.hash().'
        : !loginPassed && res.status === 500
        ? 'Login route crashed — check loginUser() is imported from @/lib/managed/auth and called as: const { token, user } = await loginUser(email, password)'
        : undefined,
      fixFile: loginRelPath.startsWith('app/') ? loginRelPath : undefined,
    });
  } catch (err) {
    steps.push({
      label: 'Login (POST)',
      url: loginUrl,
      method: 'POST',
      required: true,
      passed: false,
      error: err instanceof Error ? err.message : 'Network error',
      requestBody: JSON.stringify(loginBody),
      fixHint: 'Login endpoint did not respond. Ensure the route file exists.',
    });
  }

  // ── Step 3: Session check (optional — soft fail) ───────────────────────────
  if (loginPassed && sessionCookie) {
    try {
      const { url: meUrl, exists } = await probeEndpoint(base, ME_CANDIDATES);
      if (exists) {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(meUrl, {
          method: 'GET',
          signal: ctrl.signal,
          headers: { Cookie: sessionCookie, Accept: 'application/json' },
        });
        const bodyText = await res.text().catch(() => '');
        const mePassed = res.ok;
        steps.push({
          label: 'Session check (GET /me)',
          url: meUrl,
          method: 'GET',
          required: false,
          passed: mePassed,
          statusCode: res.status,
          sessionCookie,
          responseBody: bodyText.slice(0, 300),
          error: mePassed ? undefined : `Session check returned ${res.status}`,
          fixHint: !mePassed
            ? `The /me route returned ${res.status} even after login. Ensure it reads the cookie: const auth = await getAuthUser(request); and returns the user. Cookie sent: ${sessionCookie}`
            : undefined,
        });
      }
    } catch { /* non-critical */ }
  }

  // ── Step 4: Protected page access ─────────────────────────────────────────
  if (loginPassed && sessionCookie) {
    const { url: dashUrl, exists, status } = await probePage(base, PROTECTED_PAGE_CANDIDATES, sessionCookie);
    if (exists) {
      const dashPassed = status === 200;
      steps.push({
        label: 'Protected page (with session)',
        url: dashUrl,
        method: 'GET',
        required: false,
        passed: dashPassed || (status >= 300 && status < 400), // redirect is also acceptable
        statusCode: status,
        sessionCookie,
        error: (!dashPassed && status < 300) ? `Protected page returned ${status} even with valid session` : undefined,
        fixHint: status >= 500
          ? `The protected page crashed with ${status} even when a valid session cookie is present. Check that getAuthUser(request) is awaited and auth is not required for sub-components that can't access headers.`
          : undefined,
      });
    }
  }

  // ── Unauthenticated protected page redirect check ─────────────────────────
  const { url: anonDashUrl, exists: anonExists, status: anonStatus } =
    await probePage(base, PROTECTED_PAGE_CANDIDATES);
  if (anonExists) {
    const isRedirect = anonStatus >= 300 && anonStatus < 400;
    const is401 = anonStatus === 401 || anonStatus === 403;
    // 302/307 to login = correct, 200 showing login form = also OK, 401/403 = bad (should redirect)
    const correctBehaviour = isRedirect || anonStatus === 200;
    steps.push({
      label: 'Protected page (no session) → should redirect',
      url: anonDashUrl,
      method: 'GET',
      required: false,
      passed: correctBehaviour,
      statusCode: anonStatus,
      error: is401
        ? `Protected page returns HTTP ${anonStatus} when unauthenticated — should redirect to /login instead`
        : undefined,
      fixHint: is401
        ? `Replace: return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })\nWith: return NextResponse.redirect(new URL('/login', request.url))\nThis goes in the page component or its layout where getAuthUser returns null.`
        : undefined,
    });
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  const authPassed = registerPassed && loginPassed;
  const requiredFailed = steps.filter(s => s.required && !s.passed);

  return {
    passed: authPassed,
    steps,
    detectedFields: fields,
    summary: authPassed
      ? `Auth flow passed: register(${fields.emailField}) + login + cookie set`
      : `Auth flow failed: ${requiredFailed.map(s => `${s.label} → ${s.error?.slice(0, 60)}`).join('; ')}`,
  };
}

/**
 * Convert auth flow steps to VerificationCheck-compatible objects for the repair loop.
 */
export function authFlowToChecks(
  result: AuthFlowResult,
): Array<{
  name: string;
  url: string;
  passed: boolean;
  softPassed?: boolean;
  statusCode?: number;
  error?: string;
  requestBody?: string;
  responseBody?: string;
  rootCause?: {
    kind: string;
    detail: string;
    fixHint?: string;
    fixFile?: string;
    errorText?: string;
  };
}> {
  return result.steps.map(step => {
    const isCritical = step.required && !step.passed;
    const kind = !step.passed
      ? step.statusCode === 400 ? 'auth-field-mismatch'
      : step.statusCode === 401 ? 'auth-misconfigured'
      : step.statusCode === 500 ? 'runtime-crash'
      : 'route-failure'
      : 'unknown';

    return {
      name: `Auth: ${step.label}`,
      url: step.url,
      passed: step.passed,
      softPassed: !step.required && !step.passed,
      statusCode: step.statusCode,
      requestBody: step.requestBody,
      responseBody: step.responseBody,
      error: step.error,
      rootCause: isCritical ? {
        kind,
        detail: step.error ?? `${step.label} failed with HTTP ${step.statusCode}`,
        fixHint: step.fixHint,
        fixFile: step.fixFile,
        errorText: step.responseBody,
      } : undefined,
    };
  });
}
