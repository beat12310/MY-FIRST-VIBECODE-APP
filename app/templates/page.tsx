'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PROJECT_TEMPLATES, TEMPLATE_CATEGORIES, type ProjectTemplate } from '@/lib/project-templates';
import { useAuth } from '@/lib/auth-context';

const COMPLEXITY_COLOR: Record<string, string> = {
  Beginner:     'rgba(34,197,94,0.15)',
  Intermediate: 'rgba(234,179,8,0.15)',
  Advanced:     'rgba(239,68,68,0.15)',
};
const COMPLEXITY_TEXT: Record<string, string> = {
  Beginner:     '#4ade80',
  Intermediate: '#fbbf24',
  Advanced:     '#f87171',
};

function TemplateCard({ t, onUse }: { t: ProjectTemplate; onUse: (t: ProjectTemplate) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'rgba(20,20,36,0.95)' : 'rgba(15,15,25,0.7)',
        border: `1px solid ${hovered ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.07)'}`,
        borderRadius: 16, padding: 28, display: 'flex', flexDirection: 'column', gap: 0,
        transition: 'all 0.18s', transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? '0 8px 32px rgba(139,92,246,0.12)' : 'none',
        cursor: 'default',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 36 }}>{t.icon}</div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
            background: COMPLEXITY_COLOR[t.complexity], color: COMPLEXITY_TEXT[t.complexity],
          }}>
            {t.complexity}
          </span>
          <span style={{ fontSize: 11, color: '#64748b' }}>{t.estimatedTime}</span>
        </div>
      </div>

      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginBottom: 8 }}>{t.name}</h3>
      <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6, marginBottom: 16, flex: 1 }}>{t.description}</p>

      {/* Features */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
        {t.features.slice(0, 4).map(f => (
          <span key={f} style={{ fontSize: 11, color: '#64748b', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', padding: '2px 8px', borderRadius: 4 }}>
            {f}
          </span>
        ))}
        {t.features.length > 4 && (
          <span style={{ fontSize: 11, color: '#475569' }}>+{t.features.length - 4} more</span>
        )}
      </div>

      {/* Category tag */}
      <div style={{ marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: '#8b5cf6', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)', padding: '2px 8px', borderRadius: 4 }}>
          {t.category}
        </span>
      </div>

      <button
        onClick={() => onUse(t)}
        style={{
          width: '100%', padding: '11px', borderRadius: 9, border: 'none', cursor: 'pointer',
          background: hovered ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(139,92,246,0.1)',
          color: hovered ? '#fff' : '#a78bfa',
          fontSize: 14, fontWeight: 600,
          transition: 'all 0.18s',
        }}
      >
        Use this template →
      </button>
    </div>
  );
}

export default function TemplatesPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');

  const filtered = PROJECT_TEMPLATES.filter(t => {
    const matchCat = category === 'All' || t.category === category;
    const matchSearch = !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()) || t.tags.some(tag => tag.toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  function handleUse(t: ProjectTemplate) {
    if (!user) {
      router.push('/auth/signup');
      return;
    }
    // Pass template prompt to builder via query param
    router.push(`/builder?template=${encodeURIComponent(t.id)}`);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#06060c', color: '#f8fafc', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' }}>
      {/* Nav */}
      <nav style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '0 32px', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <div style={{ width: 28, height: 28, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>⚡</div>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc' }}>DWOMOH Vibe Code</span>
        </Link>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {user ? (
            <Link href="/dashboard" style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'none' }}>Dashboard</Link>
          ) : (
            <Link href="/auth/signup" style={{ background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>Sign up free</Link>
          )}
        </div>
      </nav>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '60px 32px' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 52 }}>
          <h1 style={{ fontSize: 'clamp(32px,5vw,52px)', fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 14 }}>
            Start from a template
          </h1>
          <p style={{ color: '#94a3b8', fontSize: 17, maxWidth: 480, margin: '0 auto' }}>
            Production-ready prompts for real apps. One click to generate.
          </p>
        </div>

        {/* Search + filter */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 36, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search templates…"
            style={{
              flex: '1 1 240px', minWidth: 200, padding: '10px 16px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 10, color: '#f8fafc', fontSize: 14, outline: 'none',
            }}
            onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.5)')}
            onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.09)')}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {TEMPLATE_CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid',
                  borderColor: category === cat ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.08)',
                  background: category === cat ? 'rgba(139,92,246,0.12)' : 'transparent',
                  color: category === cat ? '#a78bfa' : '#64748b',
                  fontSize: 13, fontWeight: category === cat ? 600 : 400, cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Count */}
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 28 }}>
          {filtered.length} template{filtered.length !== 1 ? 's' : ''}
          {category !== 'All' ? ` in ${category}` : ''}
          {search ? ` matching "${search}"` : ''}
        </p>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#64748b', fontSize: 15 }}>
            No templates match your search.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 20 }}>
            {filtered.map(t => (
              <TemplateCard key={t.id} t={t} onUse={handleUse} />
            ))}
          </div>
        )}

        {/* CTA */}
        {!user && (
          <div style={{ marginTop: 80, textAlign: 'center', padding: '48px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)', borderRadius: 20 }}>
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>Ready to build?</h2>
            <p style={{ color: '#64748b', fontSize: 15, marginBottom: 28 }}>Create a free account to start generating from any template.</p>
            <Link href="/auth/signup" style={{ display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '12px 32px', borderRadius: 10, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
              Sign up free — 3 generations included
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
