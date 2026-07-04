'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, signOut, signInWithRedirect } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';
import { isSocialConfigured } from '@/app/components/ConfigureAmplify';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: '12px 16px', color: '#f8fafc', fontSize: 15,
  outline: 'none', transition: 'border-color 0.15s',
};

const socialBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
  width: '100%', padding: '11px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)', color: '#f8fafc', fontSize: 14, fontWeight: 600,
  cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
};

function SocialButtons({ disabled }: { disabled: boolean }) {
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [socialError, setSocialError] = useState('');

  async function handleSocial(provider: 'Google' | 'Apple' | 'Facebook') {
    setSocialLoading(provider);
    setSocialError('');
    try {
      await signInWithRedirect({ provider });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'UserAlreadyAuthenticatedException') {
        // Stale session in localStorage is blocking the redirect.
        // Sign out locally (clears tokens without a server round-trip), then retry.
        try {
          await signOut({ global: false });
          await signInWithRedirect({ provider });
          // If we get here signInWithRedirect threw again — fall through to error display
        } catch (retryErr: unknown) {
          const re = retryErr as { name?: string; message?: string };
          setSocialLoading(null);
          setSocialError(re.message ?? `${provider} sign-in failed — please try again.`);
        }
      } else {
        setSocialLoading(null);
        setSocialError(e.message ?? `${provider} sign-in failed — please try again.`);
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Google */}
      <button
        type="button"
        onClick={() => handleSocial('Google')}
        disabled={disabled || !!socialLoading}
        style={socialBtnStyle}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.22)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)'; }}
      >
        {socialLoading === 'Google' ? (
          <span style={{ fontSize: 13 }}>Redirecting to Google…</span>
        ) : (
          <>
            {/* Google "G" icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </>
        )}
      </button>

      {/* Apple */}
      <button
        type="button"
        onClick={() => handleSocial('Apple')}
        disabled={disabled || !!socialLoading}
        style={socialBtnStyle}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.22)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)'; }}
      >
        {socialLoading === 'Apple' ? (
          <span style={{ fontSize: 13 }}>Redirecting to Apple…</span>
        ) : (
          <>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
            </svg>
            Continue with Apple
          </>
        )}
      </button>

      {socialError && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', color: '#fca5a5', fontSize: 14, marginTop: 4 }}>
          {socialError}
        </div>
      )}
    </div>
  );
}

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

  useEffect(() => {
    if (!loading && user) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
        <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  if (user) return null;

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>Welcome back</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>Sign in to your DWOMOH Vibe Code account</p>
      </div>

      {verified && (
        <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 10, padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#86efac', marginBottom: 2 }}>Email verified successfully!</div>
            <div style={{ fontSize: 13, color: '#4ade80' }}>Enter your password to continue to your dashboard.</div>
          </div>
        </div>
      )}

      {/* Social sign-in — only rendered when Cognito domain is configured */}
      {isSocialConfigured && (
        <>
          <SocialButtons disabled={submitting} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <span style={{ color: '#475569', fontSize: 13 }}>or</span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
          </div>
        </>
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
