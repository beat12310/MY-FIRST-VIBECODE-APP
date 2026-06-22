'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, signOut } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: '12px 16px', color: '#f8fafc', fontSize: 15,
  outline: 'none', transition: 'border-color 0.15s',
};

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading, refresh } = useAuth();

  const verified = params.get('verified') === 'true';
  const prefillEmail = params.get('email') ?? '';

  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // If a valid session already exists, skip the sign-in form entirely.
  useEffect(() => {
    if (!loading && user) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  // Pre-fill email from URL (e.g. coming from verify fallback)
  useEffect(() => {
    if (prefillEmail) setEmail(prefillEmail);
  }, [prefillEmail]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const result = await signIn({ username: email, password });

      if (result.isSignedIn) {
        await refresh();
        router.replace('/dashboard');
        return;
      }

      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_UP') {
        router.push(`/auth/verify?email=${encodeURIComponent(email)}`);
        return;
      }

      setError(`Unexpected sign-in step: ${result.nextStep?.signInStep ?? 'unknown'}`);
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };

      if (e.name === 'UserAlreadyAuthenticatedException') {
        // A valid session exists in the browser — sync context and go to dashboard.
        // This happens when autoSignIn() succeeded during email verification but
        // the user navigated back to this page anyway.
        await refresh();
        router.replace('/dashboard');
        return;
      }

      if (e.name === 'UserNotConfirmedException') {
        router.push(`/auth/verify?email=${encodeURIComponent(email)}`);
        return;
      }

      if (e.name === 'PasswordResetRequiredException') {
        router.push(`/auth/forgot-password?email=${encodeURIComponent(email)}`);
        return;
      }

      if (e.name === 'NotAuthorizedException' || e.name === 'UserNotFoundException') {
        setError('Incorrect email or password.');
      } else {
        setError(e.message ?? 'Sign in failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOutAndRetry() {
    await signOut();
    setError('');
  }

  // While checking for an existing session, show nothing (avoids flash of sign-in form)
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
        <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  // Already authenticated — the useEffect above will redirect, render nothing in the meantime
  if (user) return null;

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>Welcome back</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>Sign in to your DWOMOH Vibe Code account</p>
      </div>

      {/* Email-verified success banner */}
      {verified && (
        <div style={{
          background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
          borderRadius: 10, padding: '12px 16px', marginBottom: 24,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#86efac', marginBottom: 2 }}>Email verified successfully!</div>
            <div style={{ fontSize: 13, color: '#4ade80' }}>Enter your password to continue to your dashboard.</div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              autoFocus={!!prefillEmail}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
          <Link href="/auth/forgot-password" style={{ fontSize: 13, color: '#8b5cf6', textDecoration: 'none' }}>
            Forgot password?
          </Link>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#fca5a5', fontSize: 14 }}>
            <div>{error}</div>
            {error.includes('already') && (
              <button
                type="button"
                onClick={handleSignOutAndRetry}
                style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 13, textDecoration: 'underline', padding: 0 }}
              >
                Sign out existing session and try again
              </button>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: '100%', padding: '13px', borderRadius: 10, border: 'none',
            cursor: submitting ? 'not-allowed' : 'pointer',
            background: submitting ? 'rgba(139,92,246,0.5)' : 'linear-gradient(135deg,#8b5cf6,#6366f1)',
            color: '#fff', fontSize: 15, fontWeight: 700,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p style={{ textAlign: 'center', marginTop: 28, fontSize: 14, color: '#64748b' }}>
        No account yet?{' '}
        <Link href="/auth/signup" style={{ color: '#8b5cf6', textDecoration: 'none', fontWeight: 600 }}>
          Create one free
        </Link>
      </p>
    </div>
  );
}

export default function SignInPage() {
  return <Suspense><SignInForm /></Suspense>;
}
