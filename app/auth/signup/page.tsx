'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signUp } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: '12px 16px', color: '#f8fafc', fontSize: 15,
  outline: 'none', transition: 'border-color 0.15s',
};

function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const planHint = params.get('plan') ?? 'free';

  // Redirect already-authenticated users away from the sign-up page
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
          autoSignIn: true, // queues a pending session token used by autoSignIn() after verification
        },
      });
      router.push(`/auth/verify?email=${encodeURIComponent(email)}&plan=${planHint}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>Create your account</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>Start building with DWOMOH Vibe Code — free.</p>
      </div>

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

        <button type="submit" disabled={submitting} style={{
          width: '100%', padding: '13px', borderRadius: 10, border: 'none',
          cursor: submitting ? 'not-allowed' : 'pointer',
          background: submitting ? 'rgba(139,92,246,0.5)' : 'linear-gradient(135deg,#8b5cf6,#6366f1)',
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
