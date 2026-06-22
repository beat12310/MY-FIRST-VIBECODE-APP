'use client';

import { useState } from 'react';
import Link from 'next/link';
import { resetPassword, confirmResetPassword } from 'aws-amplify/auth';

type Step = 'request' | 'confirm' | 'done';

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10, padding: '12px 16px', color: '#f8fafc', fontSize: 15, outline: 'none',
  };

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await resetPassword({ username: email });
      setStep('confirm');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reset code');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await confirmResetPassword({ username: email, confirmationCode: code, newPassword });
      setStep('done');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  if (step === 'done') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: '#f8fafc', marginBottom: 10 }}>Password reset!</h1>
        <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 32 }}>You can now sign in with your new password.</p>
        <Link href="/auth/signin" style={{
          display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
          color: '#fff', padding: '12px 28px', borderRadius: 10, fontSize: 15, fontWeight: 700, textDecoration: 'none',
        }}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 8 }}>
          {step === 'request' ? 'Reset your password' : 'Enter your new password'}
        </h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>
          {step === 'request'
            ? 'Enter your email and we will send a reset code.'
            : `We sent a code to ${email}`}
        </p>
      </div>

      {step === 'request' ? (
        <form onSubmit={handleRequest}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)} required
              placeholder="you@example.com" style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
          </div>
          {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#fca5a5', fontSize: 14 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', cursor: loading ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', fontSize: 15, fontWeight: 700 }}>
            {loading ? 'Sending…' : 'Send reset code'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleConfirm}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Reset code</label>
              <input
                type="text" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required inputMode="numeric" placeholder="123456"
                style={{ ...inputStyle, textAlign: 'center', letterSpacing: '0.3em', fontSize: 20, fontWeight: 700 }}
                onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>New password</label>
              <input
                type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                required minLength={8} placeholder="••••••••" style={inputStyle}
                onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
              />
            </div>
          </div>
          {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, color: '#fca5a5', fontSize: 14 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', cursor: loading ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', fontSize: 15, fontWeight: 700 }}>
            {loading ? 'Resetting…' : 'Set new password'}
          </button>
        </form>
      )}

      <p style={{ textAlign: 'center', marginTop: 24, fontSize: 14 }}>
        <Link href="/auth/signin" style={{ color: '#64748b', textDecoration: 'none' }}>Back to sign in</Link>
      </p>
    </div>
  );
}
