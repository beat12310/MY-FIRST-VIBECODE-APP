'use client';

/**
 * /auth/callback — Handles the OAuth 2.0 authorization code redirect from Cognito.
 *
 * When a user signs in via Google, Apple, or Facebook through the Cognito Hosted UI,
 * Cognito redirects here with `?code=...`. Amplify v6 intercepts this automatically
 * and exchanges the code for tokens. We just need to:
 *  1. Wait for Amplify to finish (it fires during Amplify.configure())
 *  2. Refresh auth context
 *  3. Redirect to dashboard
 *
 * If exchange fails we redirect to /auth/signin with an error.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentUser } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';

export default function AuthCallbackPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [status, setStatus] = useState<'processing' | 'error'>('processing');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function handleCallback() {
      // Amplify v6 processes the authorization code automatically when the page loads
      // (it reads ?code= from the URL). We just need to wait for it to complete by
      // polling getCurrentUser().
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await getCurrentUser();
          // Session established
          if (!cancelled) {
            await refresh();
            router.replace('/dashboard');
          }
          return;
        } catch {
          // Not ready yet — wait 500ms and retry
          await new Promise(r => setTimeout(r, 500));
        }
      }
      // Timeout — couldn't establish session
      if (!cancelled) {
        setStatus('error');
        setErrorMsg('Authentication timed out. The sign-in link may have expired.');
      }
    }

    // Check if there's an error in the URL (e.g. user denied Google access)
    const params = new URLSearchParams(window.location.search);
    const urlError = params.get('error_description') ?? params.get('error');
    if (urlError) {
      setStatus('error');
      setErrorMsg(decodeURIComponent(urlError.replace(/\+/g, ' ')));
      return;
    }

    handleCallback().catch(e => {
      if (!cancelled) {
        setStatus('error');
        setErrorMsg(e?.message ?? 'Unknown error during authentication');
      }
    });

    return () => { cancelled = true; };
  }, [router, refresh]);

  if (status === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', color: '#f8fafc' }}>
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '32px 40px', textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: '#fca5a5' }}>Sign-in failed</h2>
          <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>{errorMsg}</p>
          <a href="/auth/signin" style={{ display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '10px 24px', borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>
            Back to Sign In
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', color: '#f8fafc' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 48, height: 48, border: '3px solid rgba(139,92,246,0.3)', borderTopColor: '#8b5cf6', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px' }} />
        <p style={{ color: '#94a3b8', fontSize: 15 }}>Completing sign-in…</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}
