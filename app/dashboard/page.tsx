'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PLANS_LIST } from '@/lib/subscription-plans';

interface SubData {
  planId: string;
  generationsUsedThisMonth: number;
  createdAt: string;
}

interface ProjectSummary {
  name: string;
  path: string;
  createdAt: string;
  status: string;
  port?: number;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function StatCard({ label, value, sub, accent = 'purple', icon, trend }: {
  label: string; value: string; sub: string;
  accent?: 'purple' | 'blue' | 'green' | 'orange' | 'red';
  icon: string; trend?: string;
}) {
  const A = {
    purple: { glow: 'rgba(139,92,246,0.15)', text: '#a78bfa' },
    blue:   { glow: 'rgba(59,130,246,0.15)',  text: '#93c5fd' },
    green:  { glow: 'rgba(34,197,94,0.15)',   text: '#86efac' },
    orange: { glow: 'rgba(245,158,11,0.15)',  text: '#fcd34d' },
    red:    { glow: 'rgba(239,68,68,0.15)',   text: '#fca5a5' },
  }[accent];
  return (
    <div style={{
      background: 'linear-gradient(160deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))',
      border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16,
      padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', gap: 10,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: '50%', background: A.glow, filter: 'blur(20px)', pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: A.glow, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{icon}</div>
      </div>
      <div>
        <div style={{ fontSize: 32, fontWeight: 800, color: '#f1f5f9', lineHeight: 1, letterSpacing: '-0.03em', marginBottom: 5 }}>{value}</div>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>{sub}</div>
      </div>
      {trend && <div style={{ fontSize: 12, color: A.text, background: A.glow, padding: '3px 8px', borderRadius: 100, width: 'fit-content' }}>{trend}</div>}
    </div>
  );
}

const EXAMPLES = [
  'A hotel booking app with search & rooms',
  'An e-commerce store with cart & checkout',
  'A SaaS analytics dashboard with charts',
  'A task manager with Kanban boards',
  'A job board with listings and apply flow',
];

export default function DashboardPage() {
  const { user, getToken } = useAuth();
  const router = useRouter();
  const [sub, setSub] = useState<SubData | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const token = await getToken();
      const authHeaders: Record<string, string> = {};
      if (token) authHeaders['Authorization'] = `Bearer ${token}`;
      const [subRes, projRes] = await Promise.all([
        fetch(`/api/subscription?userId=${user.userId}`).then(r => r.json()).catch(() => null),
        fetch('/api/projects', { headers: authHeaders }).then(r => r.json()).catch(() => ({ projects: [] })),
      ]);
      setSub(subRes);
      setProjects(projRes.projects ?? []);
      setDataLoading(false);
    })();
  }, [user, getToken]);

  const plan = PLANS_LIST.find(p => p.id === (sub?.planId ?? 'free')) ?? PLANS_LIST[0];
  const used = sub?.generationsUsedThisMonth ?? 0;
  const limit = plan.limits.generationsPerMonth;
  const pct = limit === 999 ? 5 : Math.min(100, Math.round((used / limit) * 100));
  const remaining = limit === 999 ? '∞' : String(Math.max(0, limit - used));
  const isNearLimit = pct >= 80 && limit !== 999;
  const barColor = isNearLimit ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#8b5cf6,#6366f1)';
  const firstName = user?.name ? user.name.split(' ')[0] : null;

  const handleGenerate = () => {
    const p = prompt.trim();
    if (!p) { promptRef.current?.focus(); return; }
    router.push(`/builder?prompt=${encodeURIComponent(p)}`);
  };

  return (
    <div style={{ maxWidth: 1200, width: '100%' }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes glow-pulse { 0%,100%{opacity:0.4} 50%{opacity:0.8} }
      `}</style>

      {/* ── Hero ───────────────────────────────────────────── */}
      <div style={{
        textAlign: 'center', padding: '52px 24px 60px', marginBottom: 36,
        position: 'relative', overflow: 'hidden', borderRadius: 24,
        background: 'linear-gradient(160deg,rgba(139,92,246,0.07) 0%,rgba(99,102,241,0.04) 60%,transparent 100%)',
        border: '1px solid rgba(139,92,246,0.12)',
      }}>
        <div style={{ position: 'absolute', top: -80, left: '50%', transform: 'translateX(-50%)', width: 500, height: 250, background: 'radial-gradient(ellipse,rgba(139,92,246,0.14),transparent 70%)', pointerEvents: 'none', animation: 'glow-pulse 5s ease-in-out infinite' }} />

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 14px', borderRadius: 100, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)', marginBottom: 22, position: 'relative' }}>
          <span style={{ fontSize: 12 }}>⚡</span>
          <span style={{ fontSize: 12, color: '#a78bfa', fontWeight: 700, letterSpacing: '0.04em' }}>AI App Builder</span>
        </div>

        <h1 style={{ fontSize: 'clamp(28px,4.5vw,52px)', fontWeight: 900, letterSpacing: '-0.04em', color: '#f8fafc', lineHeight: 1.1, marginBottom: 14, position: 'relative' }}>
          {firstName ? `Hey ${firstName}, what do you` : 'What do you'}<br />
          <span style={{ background: 'linear-gradient(135deg,#a78bfa,#818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            want to build today?
          </span>
        </h1>
        <p style={{ color: '#64748b', fontSize: 15, lineHeight: 1.65, marginBottom: 32, maxWidth: 500, marginLeft: 'auto', marginRight: 'auto', position: 'relative' }}>
          Describe your idea in plain English. No code needed — AI builds a complete, working app in minutes.
        </p>

        {/* Prompt box */}
        <div style={{ maxWidth: 700, margin: '0 auto', position: 'relative' }}>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
            placeholder="E.g. A marketplace where users can buy and sell handmade jewellery with photos, search, and direct messaging..."
            rows={3}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(15,23,42,0.8)',
              border: '1.5px solid rgba(139,92,246,0.35)',
              borderRadius: 16, padding: '18px 160px 18px 20px',
              color: '#f8fafc', fontSize: 15, lineHeight: 1.6,
              outline: 'none', resize: 'none', fontFamily: 'inherit',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
            }}
            onFocus={e => { e.target.style.borderColor = 'rgba(139,92,246,0.7)'; e.target.style.boxShadow = '0 0 0 3px rgba(139,92,246,0.12), 0 4px 24px rgba(0,0,0,0.3)'; }}
            onBlur={e => { e.target.style.borderColor = 'rgba(139,92,246,0.35)'; e.target.style.boxShadow = '0 4px 24px rgba(0,0,0,0.3)'; }}
          />
          <button
            onClick={handleGenerate}
            style={{
              position: 'absolute', right: 12, bottom: 12,
              padding: '11px 22px',
              background: prompt.trim() ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(139,92,246,0.25)',
              border: 'none', borderRadius: 12,
              color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: prompt.trim() ? 'pointer' : 'default',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
              boxShadow: prompt.trim() ? '0 4px 16px rgba(139,92,246,0.35)' : 'none',
            }}
          >
            Generate App ⚡
          </button>
        </div>

        {/* Example chips */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 20, position: 'relative' }}>
          {EXAMPLES.map(ex => (
            <button
              key={ex}
              onClick={() => { setPrompt(ex); promptRef.current?.focus(); }}
              style={{
                padding: '5px 13px', borderRadius: 100,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                color: '#64748b', fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(139,92,246,0.45)'; t.style.color = '#a78bfa'; t.style.background = 'rgba(139,92,246,0.08)'; }}
              onMouseLeave={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(255,255,255,0.1)'; t.style.color = '#64748b'; t.style.background = 'rgba(255,255,255,0.04)'; }}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* ── Status row ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 30 }}>
        {[
          {
            label: 'Your Apps',
            value: dataLoading ? '—' : String(projects.length),
            icon: '🚀',
            desc: projects.length === 1 ? '1 app generated' : `${projects.length} apps generated`,
            href: '/dashboard/projects',
          },
          {
            label: 'Deployment',
            value: projects.length > 0 ? 'Local' : 'None yet',
            icon: '🌐',
            desc: projects.length > 0 ? 'Running locally · click Deploy to go live' : 'Build your first app above',
            href: '/builder',
          },
          {
            label: 'Plan',
            value: plan.name,
            icon: '💎',
            desc: limit === 999 ? 'Unlimited generations' : `${used} / ${limit} generations used`,
            href: '/dashboard/billing',
          },
        ].map(card => (
          <Link key={card.label} href={card.href} style={{
            display: 'block', textDecoration: 'none',
            background: 'linear-gradient(160deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))',
            border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14,
            padding: '18px 20px', transition: 'border-color 0.15s, transform 0.12s',
          }}
            onMouseEnter={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(139,92,246,0.3)'; t.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(255,255,255,0.08)'; t.style.transform = 'none'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 20 }}>{card.icon}</span>
              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{card.label}</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: 4 }}>{card.value}</div>
            <div style={{ fontSize: 12, color: '#475569' }}>{card.desc}</div>
          </Link>
        ))}
      </div>

      {/* ── Stats grid ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginBottom: 28 }}>
        <StatCard label="Current plan" value={plan.name} sub={plan.price === 0 ? 'Free forever' : `${plan.priceMonthly} / month`} accent="purple" icon="💎" trend={plan.id === 'free' ? 'Free tier' : 'Active'} />
        <StatCard label="Generations used" value={limit === 999 ? `${used}` : `${used} / ${limit}`} sub="This billing month" accent={isNearLimit ? 'red' : 'blue'} icon="⚡" trend={isNearLimit ? `${100 - pct}% left` : `${pct}% used`} />
        <StatCard label="Total projects" value={String(projects.length)} sub={projects.length === 1 ? '1 app generated' : `${projects.length} apps generated`} accent="green" icon="📁" trend={projects.length > 0 ? 'All time' : 'None yet'} />
        <StatCard label="Credits remaining" value={remaining} sub="Resets monthly" accent={isNearLimit ? 'orange' : 'purple'} icon="🪙" trend={limit === 999 ? 'Unlimited' : remaining === '0' ? 'None left' : `${remaining} left`} />
      </div>

      {/* ── Usage bar ──────────────────────────────────────── */}
      <div style={{ background: 'linear-gradient(160deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '22px 26px', marginBottom: 36 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 3 }}>Generation usage</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              {limit === 999 ? `${used} generations used (unlimited plan)` : `${used} of ${limit} used this month — ${Math.max(0, limit - used)} remaining`}
            </div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: isNearLimit ? '#f87171' : '#a78bfa' }}>
            {limit === 999 ? '∞' : `${pct}%`}
          </div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 100, height: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${limit === 999 ? 5 : pct}%`, borderRadius: 100, background: barColor, transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)', minWidth: pct > 0 ? 8 : 0 }} />
        </div>
        {limit !== 999 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: '#475569' }}>0</span>
            <span style={{ fontSize: 11, color: '#475569' }}>{Math.round(limit / 2)}</span>
            <span style={{ fontSize: 11, color: '#475569' }}>{limit}</span>
          </div>
        )}
        {isNearLimit && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '10px 14px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <span style={{ fontSize: 13, color: '#fca5a5', fontWeight: 600 }}>Running low on generations. </span>
            <Link href="/dashboard/billing" style={{ fontSize: 13, color: '#f87171', fontWeight: 700, textDecoration: 'underline' }}>Upgrade your plan</Link>
            <span style={{ fontSize: 13, color: '#94a3b8' }}> to keep building.</span>
          </div>
        )}
        {!isNearLimit && plan.id === 'free' && (
          <p style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
            Free plan: 3 generations/month.{' '}
            <Link href="/dashboard/billing" style={{ color: '#8b5cf6', textDecoration: 'none', fontWeight: 600 }}>Upgrade for more →</Link>
          </p>
        )}
      </div>

      {/* ── Your apps ──────────────────────────────────────── */}
      <div style={{ marginBottom: 64 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>Your apps</h2>
          {projects.length > 0 && (
            <Link href="/dashboard/projects" style={{ fontSize: 13, color: '#8b5cf6', textDecoration: 'none', fontWeight: 600 }}>View all →</Link>
          )}
        </div>

        {dataLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[1, 2, 3].map(i => <div key={i} style={{ height: 72, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', animation: 'pulse 1.5s ease-in-out infinite' }} />)}
          </div>
        ) : projects.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {projects.slice(0, 6).map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 16,
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 14, padding: '14px 18px', transition: 'border-color 0.15s, background 0.15s',
              }}
                onMouseEnter={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(139,92,246,0.2)'; t.style.background = 'rgba(139,92,246,0.03)'; }}
                onMouseLeave={e => { const t = e.currentTarget; t.style.borderColor = 'rgba(255,255,255,0.07)'; t.style.background = 'rgba(255,255,255,0.03)'; }}
              >
                <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: 'linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.15))', border: '1px solid rgba(139,92,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                  📱
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {formatDate(p.createdAt)}<span style={{ margin: '0 5px', color: '#334155' }}>·</span>{timeAgo(p.createdAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 100, background: 'rgba(34,197,94,0.1)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.15)' }}>
                    {p.status ?? 'built'}
                  </span>
                  {p.port && (
                    <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#60a5fa', textDecoration: 'none', fontWeight: 600, padding: '3px 10px', borderRadius: 100, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.15)' }}>
                      Preview ↗
                    </a>
                  )}
                  <Link href="/builder" style={{ fontSize: 12, color: '#a78bfa', textDecoration: 'none', fontWeight: 600, padding: '3px 10px', borderRadius: 100, background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)' }}>
                    Open ↗
                  </Link>
                  <Link href="/dashboard/billing" style={{ fontSize: 12, color: '#64748b', textDecoration: 'none', fontWeight: 600, padding: '3px 10px', borderRadius: 100, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    Deploy
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '56px 40px', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 16 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🚀</div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>No apps yet</h3>
            <p style={{ color: '#64748b', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              Describe your idea in the box above and AI will build it for you.<br />No code required.
            </p>
            <button
              onClick={() => { promptRef.current?.focus(); promptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
              style={{ background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '11px 28px', borderRadius: 10, fontSize: 14, fontWeight: 700, border: 'none', cursor: 'pointer' }}
            >
              Build your first app ⚡
            </button>
          </div>
        )}
      </div>

      {/* ── Pricing ────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 60 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h2 style={{ fontSize: 32, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em', marginBottom: 10 }}>Simple pricing</h2>
          <p style={{ color: '#64748b', fontSize: 15 }}>Start free. Upgrade when you need more.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16, maxWidth: 860, margin: '0 auto' }}>
          {PLANS_LIST.map(p => {
            const isCurrent = p.id === (sub?.planId ?? 'free');
            const isPro = p.id === 'pro';
            return (
              <div key={p.id} style={{
                borderRadius: 20, padding: '28px 24px', position: 'relative',
                background: isPro
                  ? 'linear-gradient(160deg,rgba(139,92,246,0.14),rgba(99,102,241,0.06))'
                  : 'rgba(255,255,255,0.03)',
                border: `1.5px solid ${isPro ? 'rgba(139,92,246,0.45)' : 'rgba(255,255,255,0.08)'}`,
              }}>
                {isPro && (
                  <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', fontSize: 10, fontWeight: 800, padding: '3px 14px', borderRadius: 100, whiteSpace: 'nowrap', letterSpacing: '0.06em' }}>
                    MOST POPULAR
                  </div>
                )}
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>{p.name}</div>
                <div style={{ fontSize: 38, fontWeight: 900, color: '#f1f5f9', letterSpacing: '-0.03em', marginBottom: 4 }}>
                  {p.price === 0 ? '$0' : p.priceMonthly}
                </div>
                <div style={{ fontSize: 13, color: '#475569', marginBottom: 24 }}>
                  {p.price === 0 ? 'Free forever' : 'per month'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                  <div style={{ fontSize: 13, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#4ade80', flexShrink: 0, fontSize: 14 }}>✓</span>
                    {limit === 999 ? 'Unlimited' : `${p.limits.generationsPerMonth}`} generations / month
                  </div>
                  {((p as { features?: string[] }).features ?? []).slice(0, 4).map((f: string, i: number) => (
                    <div key={i} style={{ fontSize: 13, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: '#4ade80', flexShrink: 0, fontSize: 14 }}>✓</span>
                      {f}
                    </div>
                  ))}
                </div>
                {isCurrent ? (
                  <div style={{ width: '100%', padding: '11px', borderRadius: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#64748b', fontSize: 14, fontWeight: 600, textAlign: 'center' }}>
                    Your current plan
                  </div>
                ) : (
                  <Link href="/dashboard/billing" style={{
                    display: 'block', textAlign: 'center', textDecoration: 'none', padding: '11px', borderRadius: 10,
                    background: isPro ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(255,255,255,0.06)',
                    border: isPro ? 'none' : '1px solid rgba(255,255,255,0.1)',
                    color: isPro ? '#fff' : '#94a3b8', fontSize: 14, fontWeight: 700,
                    boxShadow: isPro ? '0 4px 20px rgba(139,92,246,0.3)' : 'none',
                  }}>
                    {p.price === 0 ? 'Get started free' : `Upgrade to ${p.name}`}
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
