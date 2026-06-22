'use client';

import { useState, Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { updateUserAttributes } from 'aws-amplify/auth';

function SettingsContent() {
  const { user } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<'profile' | 'security'>(
    params.get('tab') === 'security' ? 'security' : 'profile'
  );
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user]);

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10, padding: '12px 16px', color: '#f8fafc', fontSize: 15, outline: 'none',
  };

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setStatus({ ok: false, msg: 'Name cannot be empty.' }); return; }
    setSaving(true);
    setStatus(null);
    try {
      await updateUserAttributes({ userAttributes: { name: name.trim() } });
      setStatus({ ok: true, msg: 'Profile updated successfully.' });
    } catch (err) {
      setStatus({ ok: false, msg: (err as Error).message ?? 'Failed to save profile.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ color: '#f8fafc', maxWidth: 700 }}>
      <div style={{ marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 6 }}>Settings</h1>
        <p style={{ color: '#64748b', fontSize: 15 }}>Manage your account details and security.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 36, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 4, width: 'fit-content' }}>
        {(['profile', 'security'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t ? 'rgba(139,92,246,0.2)' : 'transparent',
            color: tab === t ? '#a78bfa' : '#64748b',
            fontSize: 14, fontWeight: tab === t ? 600 : 400,
            textTransform: 'capitalize',
          }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div style={{ background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 32 }}>
          {/* Avatar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 32 }}>
            <div style={{
              width: 60, height: 60, borderRadius: '50%',
              background: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 800, color: '#fff', flexShrink: 0,
            }}>
              {(user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>{user?.name ?? 'Your name'}</div>
              <div style={{ fontSize: 13, color: '#64748b' }}>{user?.email}</div>
            </div>
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: '#f8fafc' }}>Profile information</h2>
          <form onSubmit={handleSaveProfile}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Display name</label>
                <input
                  type="text" value={name} onChange={e => setName(e.target.value)}
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.6)')}
                  onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Email address</label>
                <input type="email" value={user?.email ?? ''} disabled style={{ ...inputStyle, opacity: 0.45, cursor: 'not-allowed' }} />
                <p style={{ fontSize: 12, color: '#475569', marginTop: 6 }}>Email is managed through your Cognito account and cannot be changed here.</p>
              </div>
            </div>

            {status && (
              <div style={{
                background: status.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${status.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                borderRadius: 8, padding: '10px 14px', marginTop: 20,
                color: status.ok ? '#86efac' : '#fca5a5', fontSize: 14,
              }}>
                {status.msg}
              </div>
            )}

            <button
              type="submit"
              disabled={saving}
              style={{
                marginTop: 24, padding: '11px 28px', borderRadius: 9, border: 'none',
                cursor: saving ? 'wait' : 'pointer',
                background: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
                color: '#fff', fontSize: 14, fontWeight: 700,
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        </div>
      )}

      {tab === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Password change note */}
          <div style={{ background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginBottom: 6 }}>Password</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 20 }}>
              Change your password through the reset flow. This sends a code to your email address.
            </p>
            <button
              onClick={() => router.push('/auth/forgot-password')}
              style={{
                padding: '10px 22px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.05)', color: '#f8fafc', fontSize: 14, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Change password
            </button>
          </div>

          {/* Danger zone */}
          <div style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.12)', borderRadius: 16, padding: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginBottom: 6 }}>Danger zone</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 20 }}>
              Delete your account and all associated data. This action is irreversible.
            </p>
            <button
              onClick={() => alert('Account deletion is not yet enabled. Contact support@dwomoh.com.')}
              style={{
                padding: '10px 22px', borderRadius: 9, border: '1px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: 14, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Delete account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}
