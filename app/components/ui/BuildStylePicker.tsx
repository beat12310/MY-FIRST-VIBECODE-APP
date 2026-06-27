'use client';

import { useState } from 'react';

export type BuildStyle = 'classic' | 'modern' | 'premium-3d' | 'mobile-first' | 'minimal';

interface StyleOption {
  id: BuildStyle;
  label: string;
  icon: string;
  desc: string;
  accent: string;
  bg: string;
  border: string;
}

const STYLES: StyleOption[] = [
  {
    id: 'classic',
    label: 'Classic',
    icon: '🏛️',
    desc: 'Timeless layouts, clean typography, professional blue palette',
    accent: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)',
    border: 'rgba(59,130,246,0.3)',
  },
  {
    id: 'modern',
    label: 'Modern',
    icon: '⚡',
    desc: 'Bold gradients, fluid animations, vibrant color pops',
    accent: '#8b5cf6',
    bg: 'rgba(139,92,246,0.08)',
    border: 'rgba(139,92,246,0.3)',
  },
  {
    id: 'premium-3d',
    label: 'Premium 3D',
    icon: '💎',
    desc: 'Glassmorphism, depth shadows, animated surfaces and motion',
    accent: '#d4a017',
    bg: 'rgba(212,160,23,0.08)',
    border: 'rgba(212,160,23,0.3)',
  },
  {
    id: 'mobile-first',
    label: 'Mobile First',
    icon: '📱',
    desc: 'Native app feel, bottom nav, touch targets, compact spacing',
    accent: '#10b981',
    bg: 'rgba(16,185,129,0.08)',
    border: 'rgba(16,185,129,0.3)',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    icon: '◻️',
    desc: 'Pure white space, system font, no decorations, content-first',
    accent: '#94a3b8',
    bg: 'rgba(148,163,184,0.06)',
    border: 'rgba(148,163,184,0.2)',
  },
];

interface Props {
  value: BuildStyle;
  onChange: (style: BuildStyle) => void;
}

export function BuildStylePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = STYLES.find(s => s.id === value) ?? STYLES[1];

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Choose design style"
        style={{
          padding: '5px 10px',
          background: open ? current.bg : 'transparent',
          border: `1px solid ${open ? current.border : 'rgba(30,58,95,0.6)'}`,
          borderRadius: '8px',
          color: open ? current.accent : '#475569',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: '700',
          letterSpacing: '0.04em',
          transition: 'all 0.15s',
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          whiteSpace: 'nowrap',
        }}
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={() => setOpen(false)}
          />
          <div style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 50,
            background: '#0d1526',
            border: '1px solid #1e3a5f',
            borderRadius: '12px',
            padding: '8px',
            width: '260px',
            boxShadow: '0 -8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(37,99,235,0.08)',
            animation: 'fadeup 0.15s ease-out',
          }}>
            <div style={{ fontSize: '10px', color: '#475569', fontWeight: '700', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '6px', padding: '2px 4px' }}>
              Design Style
            </div>
            {STYLES.map(style => (
              <button
                key={style.id}
                type="button"
                onClick={() => { onChange(style.id); setOpen(false); }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: value === style.id ? style.bg : 'transparent',
                  border: `1px solid ${value === style.id ? style.border : 'transparent'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  marginBottom: '3px',
                  transition: 'all 0.12s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '16px' }}>{style.icon}</span>
                  <div>
                    <div style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: value === style.id ? style.accent : '#e2e8f0',
                      marginBottom: '1px',
                    }}>
                      {style.label}
                    </div>
                    <div style={{ fontSize: '10px', color: '#64748b', lineHeight: '1.4' }}>
                      {style.desc}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Design system tokens injected into the BUILD_SYSTEM_PROMPT per style
export function getStyleSystemPrompt(style: BuildStyle): string {
  const tokens: Record<BuildStyle, string> = {
    classic: `
DESIGN STYLE: Classic Professional
- Color palette: Blue (#2563eb primary), white backgrounds, gray-100 secondary surfaces
- Typography: Inter or system-ui, 14px base, clear hierarchy (h1 2xl, h2 xl, body base)
- Components: Rounded corners (rounded-lg), subtle shadows, clean borders
- Layout: Traditional header/sidebar/content grid, sticky nav, 1200px max-width
- Animations: Subtle fade-in on mount, smooth hover transitions (150ms ease)
- Framer Motion: Use AnimatePresence for page transitions, motion.div with opacity+y for cards
`,
    modern: `
DESIGN STYLE: Modern Bold
- Color palette: Purple-to-blue gradient (#7c3aed → #2563eb), dark backgrounds (#0f172a), vibrant accents
- Typography: Inter 700 for headings, gradient text on key elements, tracking-tight
- Components: Pill buttons, gradient borders, glowing hover states, bold cards
- Layout: Asymmetric grids, hero sections with large type, full-bleed images
- Animations: Spring physics, staggered list reveals, parallax scroll hints
- Framer Motion: staggerChildren 0.08s, spring {stiffness:300,damping:30}, layout animations
`,
    'premium-3d': `
DESIGN STYLE: Premium 3D / Glassmorphism
- Color palette: Deep navy (#050b18), gold accent (#d4a017), electric blue (#3b82f6), white/10 glass
- Typography: Display font for hero, medium weight body, gold gradient on key text
- Components: Glass cards (backdrop-blur-xl, bg-white/5, border-white/10), 3D hover transforms (rotateX/Y), inner glow
- Layout: Centered hero with depth layers, floating cards, spotlight effects
- Animations: 3D card tilt on hover (transform perspective-1000), shimmer effects, floating particles in bg
- CSS: backdrop-filter: blur(20px); background: rgba(255,255,255,0.05); box-shadow: 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1);
- Framer Motion: rotateX/Y on hover, scale with spring, ambient glow pulses
`,
    'mobile-first': `
DESIGN STYLE: Mobile First / Native App
- Color palette: Clean white (#ffffff), system teal (#0ea5e9) or brand color, light gray (#f8fafc) bg
- Typography: System fonts, 16px base (touch-friendly), clear contrast AA+
- Components: 44px+ touch targets, bottom navigation bar, floating action button, card swipe hints
- Layout: Single column always, sticky bottom nav, full-width tap areas, no hover-only affordances
- Animations: Slide-up modals, bounce feedback on tap, smooth page pushes (like iOS)
- Framer Motion: x-axis page transitions, scale(0.97) tap feedback, PanInfo swipe
`,
    minimal: `
DESIGN STYLE: Minimal / Content First
- Color palette: White (#ffffff) background, black (#0a0a0a) text, single accent (any color, used sparingly)
- Typography: System-ui or Georgia, generous line-height (1.7), 16px body, 2xl–3xl headings only
- Components: Borderless inputs, hairline dividers, no box-shadows, flat buttons
- Layout: Centered single column (680px max), ample whitespace (py-16 sections), no sidebars
- Animations: None or very subtle (opacity only, 200ms), no transforms, no particles
- Framer Motion: Minimal — only AnimatePresence for route changes, no decorative animation
`,
  };
  return tokens[style] ?? tokens.modern;
}
