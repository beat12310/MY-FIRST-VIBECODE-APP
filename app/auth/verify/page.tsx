'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { confirmSignUp, resendSignUpCode, autoSignIn, getCurrentUser } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';

function VerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();

  const email = params.get('email') ?? '';
  const plan = params.get('plan') ?? 'free';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const dest = plan !== 'free' ? `/dashboard/billing?upgrade=${plan}` : '/dashboard';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('');
    setLoading(true);

    try {
      // Step 1: confirm the email address
      await confirmSignUp({ username: email, confirmationCode: code });
      setStatus('Email verified! Signing you in…');
    } catch (err: unknown) {
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Verification failed. Check the code and try again.');
      return;
    }

    // Step 2: attempt auto sign-in using the token queued during signUp({ autoSignIn: true })
    try {
      const result = await autoSignIn();
      if (result.isSignedIn) {
        await refresh();
        router.replace(dest);
        return;
      }
    } catch {
      // autoSignIn() throws in two cases:
      //  a) The token expired (user took > ~5 min to verify)
      //  b) The token was already consumed (page reload, double-submit)
      // In case (b), the session may actually have been created. Check before falling back.
    }

    // Step 3: check whether a session was established despite the autoSignIn error/miss
    try {
      await getCurrentUser(); // throws if no valid session
      // Session exists — sync context and navigate
      await refresh();
      router.replace(dest);
      return;
    } catch {
      // No session. The auto-sign-in window expired; send to sign-in with a success banner.
      setLoading(false);
      router.replace(`/auth/signin?verified=true&email=${encodeURIComponent(email)}`);
    }
  }

  async function handleResend() {
    setResending(true);
    setError('');
    setStatus('');
    try {
      await resendSignUpCode({ username: email });
      setStatus('A new code was sent to your email.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not resend code. Try again.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📬</div>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>Check your email</h1>
        <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
          We sent a 6-digit code to<br />
          <span style={{ color: '#a78bfa', fontWeight: 600 }}>{email || 'your email address'}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Verification code
          </label>
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            placeholder="123456"
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box', textAlign: 'center', letterSpacing: '0.3em',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, padding: '14px 16px', color: '#f8fafc', fontSize: 26, fontWeight: 700,
              outline: 'none',
            }}
            onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
            onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
          />
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#fca5a5', fontSize: 14 }}>
            {error}
          </div>
        )}

        {status && (
          <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#86efac', fontSize: 14 }}>
            {status}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || code.length < 6}
          style={{
            width: '100%', padding: '13px', borderRadius: 10, border: 'none',
            cursor: (loading || code.length < 6) ? 'not-allowed' : 'pointer',
            background: (loading || code.length < 6) ? 'rgba(139,92,246,0.4)' : 'linear-gradient(135deg,#8b5cf6,#6366f1)',
            color: '#fff', fontSize: 15, fontWeight: 700,
          }}
        >
          {loading ? 'Verifying…' : 'Verify email'}
        </button>
      </form>

      <p style={{ textAlign: 'center', marginTop: 24, fontSize: 14, color: '#64748b' }}>
        Did not receive it?{' '}
        <button
          onClick={handleResend}
          disabled={resending}
          style={{ background: 'none', border: 'none', cursor: resending ? 'not-allowed' : 'pointer', color: '#8b5cf6', fontSize: 14, fontWeight: 600 }}
        >
          {resending ? 'Sending…' : 'Resend code'}
        </button>
      </p>

      <p style={{ textAlign: 'center', marginTop: 12, fontSize: 14 }}>
        <Link href="/auth/signin" style={{ color: '#64748b', textDecoration: 'none' }}>Back to sign in</Link>
      </p>
    </div>
  );
}

export default function VerifyPage() {
  return <Suspense><VerifyForm /></Suspense>;
}
