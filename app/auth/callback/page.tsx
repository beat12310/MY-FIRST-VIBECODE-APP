'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Hub } from 'aws-amplify/utils';
// signInWithRedirect must be imported here even though we don't call it directly.
// Its module registers enableOAuthListener as a side effect, which calls
// attemptCompleteOAuthFlow — the function that exchanges the ?code= for tokens.
// Without this import the token exchange never starts and Hub events never fire.
import { getCurrentUser, fetchAuthSession, signInWithRedirect } from 'aws-amplify/auth';
import { useAuth } from '@/lib/auth-context';

void signInWithRedirect; // prevent tree-shaking

// Writes a timestamped entry to console + sessionStorage only.
// Never displayed on screen to regular users — open DevTools to inspect.
function debugLog(msg: string): string {
  const ts = new Date().toISOString().slice(11, 23);
  const entry = `[${ts}] ${msg}`;
  console.log('[Auth Callback]', entry);
  try {
    const prev = sessionStorage.getItem('__auth_debug') ?? '';
    sessionStorage.setItem('__auth_debug', prev + entry + '\n');
  } catch { /* sessionStorage blocked */ }
  return entry;
}

export default function AuthCallbackPage() {
  const router       = useRouter();
  const { refresh }  = useAuth();
  const done         = useRef(false);
  const [status,     setStatus]     = useState<'processing' | 'error'>('processing');
  const [errorMsg,   setErrorMsg]   = useState('');
  // errorLog is only surfaced in the error UI, never in the processing screen
  const [errorLog,   setErrorLog]   = useState<string[]>([]);

  useEffect(() => {
    try { sessionStorage.setItem('__auth_debug', ''); } catch { /* ignore */ }

    const log: string[] = [];
    function capture(msg: string) {
      log.push(debugLog(msg));
    }

    function fail(msg: string) {
      if (done.current) return;
      done.current = true;
      capture('FAIL: ' + msg);
      setErrorLog([...log]);
      setStatus('error');
      setErrorMsg(msg);
    }

    async function succeed() {
      if (done.current) return;
      done.current = true;
      capture('OAuth success — verifying session tokens...');

      try {
        const session   = await fetchAuthSession({ forceRefresh: false });
        const hasAccess = Boolean(session?.tokens?.accessToken);
        const hasId     = Boolean(session?.tokens?.idToken);
        capture(`fetchAuthSession → accessToken=${hasAccess ? 'present' : 'MISSING'} idToken=${hasId ? 'present' : 'MISSING'}`);

        if (!hasAccess) {
          fail(
            'OAuth completed but no session tokens were stored. ' +
            'This may be caused by a PKCE state mismatch. Please try signing in again.'
          );
          return;
        }

        capture('Calling refresh() to update AuthProvider...');
        await refresh();
        capture('refresh() complete — queuing navigation to /dashboard');

        // Defer navigation by one animation frame so React commits setUser({...})
        // from refresh() before the dashboard layout renders. React 18 schedules
        // state commits via MessageChannel (macrotask); without this deferral the
        // dashboard renders before the commit and its auth guard sees user=null.
        requestAnimationFrame(() => {
          capture('Navigating to /dashboard');
          router.replace('/dashboard');
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        capture(`ERROR in succeed(): ${err.name} — ${err.message}`);
        fail(err.message ?? 'Authentication failed. Please try again.');
      }
    }

    const params   = new URLSearchParams(window.location.search);
    const urlError = params.get('error_description') ?? params.get('error');
    if (urlError) {
      fail(decodeURIComponent(urlError.replace(/\+/g, ' ')));
      return;
    }

    const hasCode  = Boolean(params.get('code'));
    const hasState = Boolean(params.get('state'));
    capture(`Callback started — code=${hasCode ? 'yes' : 'NO'} state=${hasState ? 'yes' : 'NO'}`);

    const unlisten = Hub.listen('auth', ({ payload }) => {
      capture(`Hub: ${payload.event}`);
      if (payload.event === 'signInWithRedirect') {
        succeed();
      } else if (payload.event === 'signInWithRedirect_failure') {
        const msg =
          (payload.data as { message?: string } | undefined)?.message ??
          'Google sign-in failed. The authorisation code may have expired — please try again.';
        fail(msg);
      }
    });

    capture('Checking for existing session (fallback)...');
    getCurrentUser()
      .then(() => { capture('getCurrentUser succeeded — using fallback path'); succeed(); })
      .catch(() => { capture('getCurrentUser: no session yet — waiting for Hub event'); });

    const timer = setTimeout(() => {
      if (!done.current) {
        const msg = hasCode
          ? 'Authentication timed out. Amplify received the code but did not complete the token exchange. Open browser DevTools → Console for details.'
          : 'No authorisation code was received from Google. Please go back and try again.';
        capture('TIMEOUT — ' + msg);
        fail(msg);
      }
    }, 30_000);

    return () => { clearTimeout(timer); unlisten(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', color: '#f8fafc', padding: '0 24px' }}>
        <div style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)', borderRadius: 14, padding: '36px 44px', textAlign: 'center', maxWidth: 520, width: '100%' }}>
          <div style={{ fontSize: 38, marginBottom: 14 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 10, color: '#fca5a5' }}>Sign-in failed</h2>
          <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>{errorMsg}</p>
          {errorLog.length > 0 && (
            <details style={{ textAlign: 'left', marginBottom: 20 }}>
              <summary style={{ color: '#475569', fontSize: 12, cursor: 'pointer', marginBottom: 8 }}>
                Technical details ({errorLog.length} steps)
              </summary>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', lineHeight: 1.9, background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '10px 12px', marginTop: 6 }}>
                {errorLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </details>
          )}
          <a
            href="/auth/signin"
            style={{ display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '11px 28px', borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}
          >
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
