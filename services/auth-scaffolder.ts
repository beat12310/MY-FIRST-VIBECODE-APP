/**
 * Authentication Scaffolder — Feature 6
 * Generates complete auth integration for NextAuth.js, Supabase Auth, Clerk, or custom JWT.
 * Every provider produces: login page, protected route middleware, session helpers, env template.
 */

export type AuthProvider = 'nextauth' | 'supabase' | 'clerk' | 'jwt';

export interface AuthFile {
  path: string;
  content: string;
}

export interface AuthScaffold {
  provider: AuthProvider;
  files: AuthFile[];
  envVars: { key: string; description: string }[];
  packages: string[];
  instructions: string[];
}

// ─── NextAuth.js ──────────────────────────────────────────────────────────────

function nextAuthScaffold(): AuthScaffold {
  return {
    provider: 'nextauth',
    files: [
      {
        path: 'lib/auth.ts',
        content: `import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        // TODO: replace with real DB lookup
        if (credentials?.email === 'demo@example.com' && credentials?.password === 'password') {
          return { id: '1', email: credentials.email, name: 'Demo User' };
        }
        return null;
      },
    }),
    // Uncomment to add Google OAuth:
    // GoogleProvider({
    //   clientId: process.env.GOOGLE_CLIENT_ID!,
    //   clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    // }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        (session.user as { id?: string }).id = token.id as string;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
`,
      },
      {
        path: 'app/api/auth/[...nextauth]/route.ts',
        content: `import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
`,
      },
      {
        path: 'components/AuthProvider.tsx',
        content: `'use client';
import { SessionProvider } from 'next-auth/react';

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
`,
      },
      {
        path: 'app/login/page.tsx',
        content: `'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      setError('Invalid email or password');
    } else {
      router.push('/');
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '32px', background: '#1e293b', borderRadius: '12px', border: '1px solid #334155' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '700', color: '#f8fafc', marginBottom: '24px', textAlign: 'center' }}>Sign In</h1>
        {error && <div style={{ padding: '10px', background: '#3b0000', border: '1px solid #ef4444', borderRadius: '6px', color: '#f87171', marginBottom: '16px', fontSize: '14px' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  );
}
`,
      },
      {
        path: 'middleware.ts',
        content: `export { default } from 'next-auth/middleware';

export const config = {
  // Protect these routes — unauthenticated users are redirected to /login
  matcher: ['/dashboard/:path*', '/admin/:path*', '/profile/:path*'],
};
`,
      },
    ],
    envVars: [
      { key: 'NEXTAUTH_SECRET', description: 'Random secret — run: openssl rand -base64 32' },
      { key: 'NEXTAUTH_URL', description: 'Your app URL — http://localhost:3000 for dev' },
      { key: 'GOOGLE_CLIENT_ID', description: '(Optional) Google OAuth client ID' },
      { key: 'GOOGLE_CLIENT_SECRET', description: '(Optional) Google OAuth client secret' },
    ],
    packages: ['next-auth'],
    instructions: [
      '1. Run: npm install next-auth',
      '2. Generate a secret: openssl rand -base64 32',
      '3. Add NEXTAUTH_SECRET and NEXTAUTH_URL to .env.local',
      '4. Wrap your root layout with <AuthProvider> from components/AuthProvider.tsx',
      '5. Replace the hardcoded demo user in lib/auth.ts with your real DB lookup',
      '6. The /login page uses email+password. Add GoogleProvider for OAuth (see comments in lib/auth.ts)',
      '7. Protected routes are configured in middleware.ts — edit the matcher to protect your pages',
    ],
  };
}

// ─── Supabase Auth ────────────────────────────────────────────────────────────

function supabaseAuthScaffold(): AuthScaffold {
  return {
    provider: 'supabase',
    files: [
      {
        path: 'lib/auth/supabase-auth.ts',
        content: `import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, key);

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}
`,
      },
      {
        path: 'app/login/page.tsx',
        content: `'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, signUp } from '@/lib/auth/supabase-auth';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        setMessage('Check your email to confirm your account.');
      } else {
        await signIn(email, password);
        router.push('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '32px', background: '#1e293b', borderRadius: '12px', border: '1px solid #334155' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '700', color: '#f8fafc', marginBottom: '24px', textAlign: 'center' }}>
          {mode === 'login' ? 'Sign In' : 'Create Account'}
        </h1>
        {error && <div style={{ padding: '10px', background: '#3b0000', border: '1px solid #ef4444', borderRadius: '6px', color: '#f87171', marginBottom: '16px', fontSize: '14px' }}>{error}</div>}
        {message && <div style={{ padding: '10px', background: '#052e16', border: '1px solid #16a34a', borderRadius: '6px', color: '#4ade80', marginBottom: '16px', fontSize: '14px' }}>{message}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? '…' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#64748b' }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '13px' }}>
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  );
}
`,
      },
      {
        path: 'app/api/auth/callback/route.ts',
        content: `import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(next, request.url));
}
`,
      },
      {
        path: 'middleware.ts',
        content: `import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const PROTECTED = ['/dashboard', '/admin', '/profile'];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some(p => path.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: \`Bearer \${request.cookies.get('supabase-auth-token')?.value}\` } } }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = { matcher: ['/dashboard/:path*', '/admin/:path*', '/profile/:path*'] };
`,
      },
    ],
    envVars: [
      { key: 'NEXT_PUBLIC_SUPABASE_URL', description: 'Supabase project URL (Settings > API)' },
      { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', description: 'Supabase anon/public key (Settings > API)' },
    ],
    packages: ['@supabase/supabase-js'],
    instructions: [
      '1. Enable Email auth in Supabase Dashboard > Authentication > Providers',
      '2. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local',
      '3. The /login page handles both sign-in and sign-up',
      '4. Protected routes are in middleware.ts — edit the PROTECTED array to add your routes',
      '5. For Google/GitHub OAuth: enable the provider in Supabase Dashboard > Auth > Providers',
    ],
  };
}

// ─── Clerk ────────────────────────────────────────────────────────────────────

function clerkScaffold(): AuthScaffold {
  return {
    provider: 'clerk',
    files: [
      {
        path: 'middleware.ts',
        content: `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/admin(.*)',
  '/profile(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};
`,
      },
      {
        path: 'app/layout.tsx',
        content: `import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'App' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
`,
      },
      {
        path: 'app/sign-in/[[...sign-in]]/page.tsx',
        content: `import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <SignIn />
    </main>
  );
}
`,
      },
      {
        path: 'app/sign-up/[[...sign-up]]/page.tsx',
        content: `import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <SignUp />
    </main>
  );
}
`,
      },
      {
        path: 'components/UserButton.tsx',
        content: `import { UserButton, SignedIn, SignedOut, SignInButton } from '@clerk/nextjs';

export default function AuthButton() {
  return (
    <>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
      <SignedOut>
        <SignInButton mode="modal">
          <button style={{ padding: '8px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: '500' }}>
            Sign In
          </button>
        </SignInButton>
      </SignedOut>
    </>
  );
}
`,
      },
    ],
    envVars: [
      { key: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', description: 'Clerk publishable key (Clerk Dashboard > API Keys)' },
      { key: 'CLERK_SECRET_KEY', description: 'Clerk secret key (Clerk Dashboard > API Keys)' },
      { key: 'NEXT_PUBLIC_CLERK_SIGN_IN_URL', description: '/sign-in' },
      { key: 'NEXT_PUBLIC_CLERK_SIGN_UP_URL', description: '/sign-up' },
      { key: 'NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL', description: '/' },
      { key: 'NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL', description: '/' },
    ],
    packages: ['@clerk/nextjs'],
    instructions: [
      '1. Create a free Clerk account at clerk.com and create an application',
      '2. Copy NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY from Clerk Dashboard',
      '3. Add all env vars to .env.local',
      '4. Run: npm install @clerk/nextjs',
      '5. The ClerkProvider is already added to app/layout.tsx',
      '6. Add <AuthButton /> from components/UserButton.tsx to your navbar',
      '7. Protected routes are configured in middleware.ts — edit createRouteMatcher to add routes',
    ],
  };
}

// ─── Custom JWT ───────────────────────────────────────────────────────────────

function jwtScaffold(): AuthScaffold {
  return {
    provider: 'jwt',
    files: [
      {
        path: 'lib/auth/jwt.ts',
        content: `import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'change-this-secret-in-production');

export interface JWTPayload {
  sub: string;   // user ID
  email: string;
  role?: string;
  iat?: number;
  exp?: number;
}

export async function signToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secret);
  return payload as unknown as JWTPayload;
}
`,
      },
      {
        path: 'lib/auth/session.ts',
        content: `import { cookies } from 'next/headers';
import { verifyToken, type JWTPayload } from './jwt';

const COOKIE = 'auth_token';

export async function getSession(): Promise<JWTPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE)?.value;
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<JWTPayload> {
  const session = await getSession();
  if (!session) throw new Error('Unauthorized');
  return session;
}
`,
      },
      {
        path: 'app/api/auth/login/route.ts',
        content: `import { NextRequest, NextResponse } from 'next/server';
import { signToken } from '@/lib/auth/jwt';

export async function POST(request: NextRequest) {
  const { email, password } = await request.json();

  // TODO: replace with real DB lookup + password hash check (use bcrypt)
  if (email === 'demo@example.com' && password === 'password') {
    const token = await signToken({ sub: '1', email, role: 'user' });
    const res = NextResponse.json({ success: true, email });
    res.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });
    return res;
  }

  return NextResponse.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
}
`,
      },
      {
        path: 'app/api/auth/logout/route.ts',
        content: `import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.delete('auth_token');
  return res;
}
`,
      },
      {
        path: 'app/api/auth/me/route.ts',
        content: `import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user: { id: session.sub, email: session.email, role: session.role } });
}
`,
      },
      {
        path: 'middleware.ts',
        content: `import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'change-this-secret-in-production');
const PROTECTED = ['/dashboard', '/admin', '/profile'];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some(p => path.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.redirect(new URL('/login', request.url));

  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = { matcher: ['/dashboard/:path*', '/admin/:path*', '/profile/:path*'] };
`,
      },
      {
        path: 'app/login/page.tsx',
        content: `'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.success) {
      router.push('/');
    } else {
      setError(data.error ?? 'Login failed');
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <div style={{ width: '100%', maxWidth: '400px', padding: '32px', background: '#1e293b', borderRadius: '12px', border: '1px solid #334155' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '700', color: '#f8fafc', marginBottom: '24px', textAlign: 'center' }}>Sign In</h1>
        {error && <div style={{ padding: '10px', background: '#3b0000', border: '1px solid #ef4444', borderRadius: '6px', color: '#f87171', marginBottom: '16px', fontSize: '14px' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#94a3b8', marginBottom: '6px' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '12px', color: '#475569' }}>Demo: demo@example.com / password</p>
      </div>
    </main>
  );
}
`,
      },
    ],
    envVars: [
      { key: 'JWT_SECRET', description: 'Random secret for signing JWTs — run: openssl rand -base64 32' },
    ],
    packages: ['jose'],
    instructions: [
      '1. Run: npm install jose',
      '2. Generate a strong secret: openssl rand -base64 32',
      '3. Add JWT_SECRET to .env.local',
      '4. Replace the hardcoded demo user in app/api/auth/login/route.ts with your DB lookup',
      '5. Add bcrypt for password hashing: npm install bcryptjs @types/bcryptjs',
      '6. Protected routes are configured in middleware.ts — edit the PROTECTED array',
      '7. Use getSession() from lib/auth/session.ts in any server component or API route to get the current user',
    ],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateAuthScaffold(provider: AuthProvider): AuthScaffold {
  switch (provider) {
    case 'nextauth':  return nextAuthScaffold();
    case 'supabase':  return supabaseAuthScaffold();
    case 'clerk':     return clerkScaffold();
    case 'jwt':       return jwtScaffold();
    default: throw new Error(`Unknown auth provider: ${provider}`);
  }
}
