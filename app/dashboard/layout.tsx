'use client';

import { type ReactNode, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/* ─── nav structure ─────────────────────────────────────────── */
const NAV_SECTIONS = [
  {
    title: null,
    items: [
      { href: '/dashboard',          label: 'Overview',      icon: <IconHome /> },
      { href: '/builder',            label: 'Builder',       icon: <IconBolt /> },
      { href: '/templates',          label: 'Templates',     icon: <IconGrid /> },
    ],
  },
  {
    title: 'Projects',
    items: [
      { href: '/dashboard/projects', label: 'My Projects',   icon: <IconFolder /> },
      { href: '/dashboard/history',  label: 'Build History', icon: <IconClock /> },
    ],
  },
  {
    title: 'Account',
    items: [
      { href: '/dashboard/billing',  label: 'Billing',       icon: <IconCard /> },
      { href: '/dashboard/settings', label: 'Settings',      icon: <IconGear /> },
    ],
  },
];

/* ─── svg icon atoms ─────────────────────────────────────────── */
function IconHome()   { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>; }
function IconBolt()   { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>; }
function IconGrid()   { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>; }
function IconFolder() { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>; }
function IconClock()  { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path strokeLinecap="round" d="M12 7v5l3 3" /></svg>; }
function IconCard()   { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path strokeLinecap="round" d="M2 10h20" /></svg>; }
function IconGear()   { return <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" /></svg>; }
function IconMenu()   { return <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>; }
function IconX()      { return <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>; }

/* ─── nav item ───────────────────────────────────────────────── */
function NavItem({ href, label, icon, active }: { href: string; label: string | React.ReactNode; icon: React.ReactNode; active: boolean }) {
  return (
    <Link href={href} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '9px 14px', borderRadius: 8, textDecoration: 'none',
      fontSize: 13.5, fontWeight: active ? 600 : 400,
      color: active ? '#e2e8f0' : '#64748b',
      background: active ? 'rgba(139,92,246,0.15)' : 'transparent',
      borderLeft: `2px solid ${active ? '#8b5cf6' : 'transparent'}`,
      marginBottom: 1, transition: 'background 0.1s, color 0.1s',
    }}
      onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLElement).style.color = '#94a3b8'; } }}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#64748b'; } }}>
      <span style={{ flexShrink: 0, opacity: active ? 1 : 0.7 }}>{icon}</span>
      {label}
    </Link>
  );
}

/* ─── sidebar content (shared between desktop and mobile drawer) */
function SidebarContent({ pathname, user, initial, planLabel, onSignOut }: {
  pathname: string;
  user: { name?: string; email: string; picture?: string };
  initial: string;
  planLabel: string;
  onSignOut: () => void;
}) {
  return (
    <>
      {/* Logo */}
      <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <div style={{ width: 28, height: 28, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <IconBolt />
          </div>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#94a3b8', letterSpacing: '-0.01em' }}>DWOMOH Vibe Code</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '14px 10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {NAV_SECTIONS.map((section, si) => (
          <div key={si} style={{ marginBottom: 22 }}>
            {section.title && (
              <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '0 14px', marginBottom: 6 }}>
                {section.title}
              </div>
            )}
            {section.items.map(item => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={pathname === item.href}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '14px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          {user.picture ? (
            <img
              src={user.picture}
              alt={user.name ?? user.email}
              referrerPolicy="no-referrer"
              style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, objectFit: 'cover', border: '2px solid rgba(139,92,246,0.3)' }}
            />
          ) : (
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              background: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 800, color: '#fff', flexShrink: 0,
            }}>
              {initial}
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.name ?? user.email.split('@')[0]}
            </div>
            <div style={{ fontSize: 11, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email.includes('@') ? user.email : planLabel + ' plan'}
            </div>
          </div>
        </div>
        <button
          onClick={onSignOut}
          style={{
            width: '100%', padding: '8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent', color: '#64748b', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { const t = e.currentTarget; t.style.background = 'rgba(239,68,68,0.08)'; t.style.color = '#f87171'; t.style.borderColor = 'rgba(239,68,68,0.2)'; }}
          onMouseLeave={e => { const t = e.currentTarget; t.style.background = 'transparent'; t.style.color = '#64748b'; t.style.borderColor = 'rgba(255,255,255,0.08)'; }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}

/* ─── layout ─────────────────────────────────────────────────── */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close drawer on route change
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  // Auth guard — runs AFTER React commits state updates. Using useEffect instead
  // of a synchronous render-time check prevents a timing race where the dashboard
  // renders before refresh()'s setUser({...}) is committed (React 18 MessageChannel
  // commits fire after microtasks, so a synchronous check sees stale user=null).
  useEffect(() => {
    if (!loading && !user) {
      console.log('[Dashboard Guard] No session after load — redirecting to sign-in');
      router.replace('/auth/signin');
    }
    if (!loading && user) {
      console.log('[Dashboard Guard] Session valid — user:', user.userId);
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div style={{ minHeight: '100vh', background: '#06060c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,sans-serif' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 36, height: 36, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <IconBolt />
          </div>
          <div style={{ color: '#475569', fontSize: 14 }}>Loading…</div>
        </div>
      </div>
    );
  }

  const displayName = user.name ?? (user.email.includes('@') ? user.email.split('@')[0] : null) ?? '?';
  const initial = displayName.slice(0, 1).toUpperCase();
  const planLabel = (user as { planId?: string }).planId ?? 'Free';

  async function handleSignOut() {
    await signOut();
    router.push('/');
  }

  const sidebarProps = { pathname, user, initial, planLabel, onSignOut: handleSignOut };

  const SIDEBAR_W = 252;

  return (
    <div style={{
      minHeight: '100vh', background: '#06060c',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      color: '#f1f5f9', display: 'flex',
    }}>

      {/* ── Desktop sidebar ─────────────────────── */}
      {!isMobile && (
        <aside style={{
          width: SIDEBAR_W, flexShrink: 0,
          background: '#08080f',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', flexDirection: 'column',
          position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 40,
          overflowY: 'auto',
        }}>
          <SidebarContent {...sidebarProps} />
        </aside>
      )}

      {/* ── Mobile overlay + drawer ──────────────── */}
      {isMobile && sidebarOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSidebarOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 48, backdropFilter: 'blur(2px)' }}
          />
          {/* Drawer */}
          <aside style={{
            position: 'fixed', top: 0, left: 0, bottom: 0, width: SIDEBAR_W,
            background: '#08080f', borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', flexDirection: 'column', zIndex: 49, overflowY: 'auto',
          }}>
            <div style={{ position: 'absolute', top: 18, right: 14 }}>
              <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4 }}>
                <IconX />
              </button>
            </div>
            <SidebarContent {...sidebarProps} />
          </aside>
        </>
      )}

      {/* ── Main area ────────────────────────────── */}
      <div style={{ flex: 1, marginLeft: isMobile ? 0 : SIDEBAR_W, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Mobile top bar */}
        {isMobile && (
          <header style={{
            position: 'sticky', top: 0, zIndex: 30,
            background: 'rgba(6,6,12,0.95)', backdropFilter: 'blur(12px)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <button onClick={() => setSidebarOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
              <IconMenu />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconBolt />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>DWOMOH Vibe Code</span>
            </div>
          </header>
        )}

        {/* Page content */}
        <main style={{ flex: 1, padding: isMobile ? '24px 16px 40px' : '36px 40px 60px', maxWidth: '100%', boxSizing: 'border-box' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
