'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signUp, signOut, signInWithRedirect } from 'aws-amplify/auth';
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

function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const planHint = params.get('plan') ?? 'free';
  const [socialLoading, setSocialLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await signUp({
        username: email,
        password,
        options: {
          userAttributes: { email, name },
          autoSignIn: true,
        },
      });
      router.push(`/auth/verify?email=${encodeURIComponent(email)}&plan=${planHint}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSocial(provider: 'Google' | 'Apple') {
    setSocialLoading(provider);
    setError('');
    try {
      await signInWithRedirect({ provider });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'UserAlreadyAuthenticatedException') {
        try {
          await signOut({ global: false });
          await signInWithRedirect({ provider });
        } catch (retryErr: unknown) {
          const re = retryErr as { name?: string; message?: string };
          setSocialLoading(null);
          setError(re.message ?? `${provider} sign-in failed — please try again.`);
        }
      } else {
        setSocialLoading(null);
        setError(e.message ?? `${provider} sign-in failed — please try again.`);
      }
    }
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>Create your account</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>Start building with DWOMOH Vibe Code — free.</p>
      </div>

      {/* Social sign-in — only rendered when Cognito domain is configured */}
      {isSocialConfigured && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
            <button
              type="button"
              onClick={() => handleSocial('Google')}
              disabled={!!socialLoading || submitting}
              style={socialBtnStyle}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            >
              {socialLoading === 'Google' ? 'Redirecting…' : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Sign up with Google
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => handleSocial('Apple')}
              disabled={!!socialLoading || submitting}
              style={socialBtnStyle}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            >
              {socialLoading === 'Apple' ? 'Redirecting…' : (
                <>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
                  </svg>
                  Sign up with Apple
                </>
              )}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <span style={{ color: '#475569', fontSize: 13 }}>or</span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="Your name"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="••••••••"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')} />
            <p style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>At least 8 characters with a number and uppercase letter.</p>
          </div>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#fca5a5', fontSize: 14 }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={submitting || !!socialLoading} style={{
          width: '100%', padding: '13px', borderRadius: 10, border: 'none',
          cursor: (submitting || !!socialLoading) ? 'not-allowed' : 'pointer',
          background: (submitting || !!socialLoading) ? 'rgba(139,92,246,0.5)' : 'linear-gradient(135deg,#8b5cf6,#6366f1)',
          color: '#fff', fontSize: 15, fontWeight: 700,
        }}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>

        <p style={{ fontSize: 12, color: '#475569', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
          By signing up you agree to our Terms of Service and Privacy Policy.
        </p>
      </form>

      <p style={{ textAlign: 'center', marginTop: 28, fontSize: 14, color: '#64748b' }}>
        Already have an account?{' '}
        <Link href="/auth/signin" style={{ color: '#8b5cf6', textDecoration: 'none', fontWeight: 600 }}>Sign in</Link>
      </p>
    </div>
  );
}

export default function SignUpPage() {
  return <Suspense><SignUpForm /></Suspense>;
}
