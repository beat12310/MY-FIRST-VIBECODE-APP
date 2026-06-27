'use client';

import './landing.css';
import dynamic from 'next/dynamic';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap, Terminal, Globe, Shield, Layers, Smartphone,
  ArrowRight, ChevronDown, Check, Plus,
  Code2, Database, GitBranch, Play, Menu, X,
} from 'lucide-react';

const ThreeBackground = dynamic(() => import('./components/ThreeBackground'), { ssr: false });

// ── Data ─────────────────────────────────────────────────────────────────────

const FEATURES = [
  { icon: Zap,        color: '#6366f1', title: 'Instant Generation',    desc: 'One sentence → complete Next.js project with TypeScript, Tailwind, API routes, auth, and database schema in under 2 minutes.' },
  { icon: Terminal,   color: '#8b5cf6', title: 'Self-Healing Pipeline',  desc: '5-round autonomous repair loop. Every TypeScript error is classified, matched against engineering memory, and patched — no input needed.' },
  { icon: Globe,      color: '#3b82f6', title: 'Live Preview',           desc: 'Your app runs instantly on a dev server. Hot-reload updates stream to the preview panel as you make follow-up requests.' },
  { icon: Shield,     color: '#22d3a0', title: 'Browser Verification',   desc: 'Playwright navigates every page, fills every form, and tests authentication before any route is marked verified.' },
  { icon: Layers,     color: '#f59e0b', title: 'Model Escalation',       desc: 'Errors route through Haiku → Sonnet → Opus automatically. Simple fixes stay fast; complex failures get the strongest model.' },
  { icon: Smartphone, color: '#ec4899', title: 'Flutter Mobile Apps',    desc: 'Generate production-ready Dart/Flutter apps alongside web projects. APK built, verified, and ready to install from the same prompt.' },
];

const PIPELINE = [
  { n: '01', icon: Code2,     label: 'Describe',  body: 'One sentence. The AI classifies intent, identifies the stack, and plans every screen, route, and data model.' },
  { n: '02', icon: Layers,    label: 'Generate',  body: 'Hundreds of files written in parallel — components, routes, schema, auth middleware, Tailwind styles, env config.' },
  { n: '03', icon: Database,  label: 'Install',   body: 'Every import detected. Missing packages installed. npm, TypeScript compile, and build checks run in sequence.' },
  { n: '04', icon: GitBranch, label: 'Repair',    body: '5-round self-healing loop. Each error classified, matched against memory, fixed by the right model.' },
  { n: '05', icon: Shield,    label: 'Verify',    body: 'A real browser navigates every route, tests forms, checks auth. Broken links repaired and re-verified before green light.' },
  { n: '06', icon: Play,      label: 'Preview',   body: 'App is live. Iframe streams the preview. Every follow-up request goes through the same pipeline — read, plan, edit, hot-reload.' },
];

const PLANS = [
  {
    id: 'free',     name: 'Free',     price: '$0',  period: '',    href: '/auth/signup',
    desc: 'Try the full pipeline.',              cta: 'Start free',    highlight: false,
    features: ['3 generations / month', 'Live preview', 'Self-healing build', 'Community support'],
  },
  {
    id: 'starter',  name: 'Starter',  price: '$9',  period: '/mo', href: '/auth/signup?plan=starter',
    desc: 'Solo builders shipping side projects.', cta: 'Get Starter',   highlight: false,
    features: ['20 generations / month', 'Save & manage projects', 'Export source code', 'Email support'],
  },
  {
    id: 'pro',      name: 'Pro',      price: '$19', period: '/mo', href: '/auth/signup?plan=pro',
    desc: 'Professionals who ship constantly.',   cta: 'Go Pro',        highlight: true,  badge: 'Most Popular',
    features: ['80 generations / month', 'Deploy & custom domains', 'Remove branding', 'Priority support', 'Flutter apps'],
  },
  {
    id: 'business', name: 'Business', price: '$49', period: '/mo', href: '/auth/signup?plan=business',
    desc: 'Teams moving at startup speed.',       cta: 'Get Business',  highlight: false,
    features: ['Unlimited generations', 'Team collaboration', 'Priority queue', 'Dedicated support', 'Analytics'],
  },
] as const;

const FAQ_ITEMS = [
  { q: 'What kinds of apps can DWOMOH Vibe Code generate?', a: 'Any web app — dashboards, e-commerce, music platforms, CRMs, SaaS tools, booking systems, property listings, and more. The AI generates complete Next.js projects with TypeScript, Tailwind, working API routes, database schemas, and authentication.' },
  { q: 'Do I need to know how to code?', a: 'Not at all. Describe what you want to build in plain English. DWOMOH Vibe Code handles generation, dependency installation, TypeScript fixes, browser verification, and live preview automatically.' },
  { q: 'What happens when the build has errors?', a: 'The self-healing pipeline catches every error. It classifies the issue, matches against an engineering memory of known patterns, and applies a fix — deterministic patches first, then Haiku, Sonnet, Opus. Up to 5 rounds before a build is considered unrecoverable.' },
  { q: 'Can I export my code?', a: 'Yes. Starter plan and above lets you download the full project as a zip or copy source code. The output is standard Next.js — no vendor lock-in.' },
  { q: 'What payment methods are supported?', a: 'Major cards via Stripe globally, and Paystack for African payments including MTN MoMo, M-Pesa, and local bank transfers.' },
  { q: 'Is Flutter mobile app generation included?', a: 'Flutter generation is available on Pro and above. The AI generates complete Dart/Flutter projects, runs flutter build apk, and verifies on connected devices or emulators.' },
];

const DEMOS = [
  'Build a Phone & Car Marketplace for Ghana',
  'Create a Boomplay-style music streaming platform',
  'Generate a hotel booking system with calendar',
  'Build a campus food delivery app',
  'Create an AI tutoring platform for students',
  'Generate a real estate marketplace with map view',
];

// ── Shared tokens ─────────────────────────────────────────────────────────────

const C = {
  text:     '#f8fafc',
  muted:    '#64748b',
  dim:      '#334155',
  surface:  'rgba(8,12,22,0.85)',
  border:   'rgba(255,255,255,0.07)',
  indigoBg: 'rgba(99,102,241,0.08)',
  indigoBd: 'rgba(99,102,241,0.25)',
  indigo:   '#6366f1',
  purple:   '#8b5cf6',
} as const;

// ── Motion helper ─────────────────────────────────────────────────────────────

const fadeUp = (delay = 0) => ({
  initial:     { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport:    { once: true, margin: '-40px' },
  transition:  { duration: 0.48, delay },
});

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 14px', borderRadius: 999, border: `1px solid ${C.indigoBd}`, background: C.indigoBg, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#818cf8', marginBottom: 20 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.indigo }} />
      {label}
    </div>
  );
}

// ── Typewriter ────────────────────────────────────────────────────────────────

function Typewriter() {
  const [typed, setTyped] = useState('');
  const s = useRef({ idx: 0, char: 0, del: false, paused: false });

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const r = s.current;
    function tick(now: number) {
      if (r.paused) { raf = requestAnimationFrame(tick); return; }
      if (now - last < (r.del ? 20 : 52)) { raf = requestAnimationFrame(tick); return; }
      last = now;
      const phrase = DEMOS[r.idx];
      if (!r.del) {
        r.char = Math.min(r.char + 1, phrase.length);
        setTyped(phrase.slice(0, r.char));
        if (r.char === phrase.length) { r.paused = true; setTimeout(() => { r.paused = false; r.del = true; }, 2600); }
      } else {
        r.char = Math.max(r.char - 1, 0);
        setTyped(phrase.slice(0, r.char));
        if (r.char === 0) { r.del = false; r.idx = (r.idx + 1) % DEMOS.length; }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span style={{ fontFamily: 'monospace', color: '#a5b4fc', fontSize: 14 }}>
      {typed}
      <span style={{ display: 'inline-block', width: 2, height: '1.1em', background: '#818cf8', marginLeft: 2, verticalAlign: 'middle', animation: 'lp-blink 1s step-end infinite' }} />
    </span>
  );
}

// ── NavBar ────────────────────────────────────────────────────────────────────

const NAV = [['Features','#features'],['How It Works','#pipeline'],['Pricing','#pricing'],['FAQ','#faq']] as const;

function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  return (
    <>
      <motion.nav initial={{ y: -16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.4 }}
        style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 64, zIndex: 50, background: scrolled ? 'rgba(6,6,14,0.95)' : 'transparent', borderBottom: scrolled ? `1px solid ${C.border}` : '1px solid transparent', backdropFilter: scrolled ? 'blur(20px)' : 'none', WebkitBackdropFilter: scrolled ? 'blur(20px)' : 'none', transition: 'background 0.25s, border-color 0.25s' }}>
        <div className="lp-container" style={{ height: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>

          {/* Logo */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 18px rgba(99,102,241,0.38)' }}>
              <Zap size={15} color="#fff" />
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>DWOMOH Vibe Code</span>
          </Link>

          {/* Desktop nav links */}
          <div className="lp-nav-links" style={{ flex: 1, justifyContent: 'center' }}>
            {NAV.map(([l, h]) => (
              <a key={l} href={h} className="lp-nav-link" style={{ padding: '6px 14px', borderRadius: 8, fontSize: 13.5, fontWeight: 500, color: '#64748b', textDecoration: 'none' }}>{l}</a>
            ))}
          </div>

          {/* Desktop CTAs */}
          <div className="lp-nav-cta-desktop" style={{ flexShrink: 0 }}>
            <Link href="/auth/signin" style={{ fontSize: 13.5, fontWeight: 600, color: '#475569', textDecoration: 'none', padding: '6px 12px' }}>Sign in</Link>
            <Link href="/auth/signup" style={{ padding: '8px 18px', borderRadius: 8, fontSize: 13.5, fontWeight: 700, color: '#fff', textDecoration: 'none', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 2px 14px rgba(99,102,241,0.35)', whiteSpace: 'nowrap' }}>Start free</Link>
          </div>

          {/* Mobile toggle */}
          <button className="lp-mobile-toggle" onClick={() => setMenuOpen(o => !o)} aria-label="Toggle menu"
            style={{ marginLeft: 'auto', width: 40, height: 40, borderRadius: 8, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)', cursor: 'pointer', alignItems: 'center', justifyContent: 'center' }}>
            {menuOpen ? <X size={18} color="#64748b" /> : <Menu size={18} color="#64748b" />}
          </button>
        </div>
      </motion.nav>

      {/* Mobile menu */}
      <div className={`lp-mobile-menu${menuOpen ? ' open' : ''}`}>
        {NAV.map(([l, h]) => (
          <a key={l} href={h} className="lp-mobile-menu-link" onClick={() => setMenuOpen(false)}>{l}</a>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          <Link href="/auth/signin" onClick={() => setMenuOpen(false)} style={{ padding: '11px 16px', borderRadius: 8, fontSize: 15, fontWeight: 600, color: '#64748b', textDecoration: 'none', textAlign: 'center', border: `1px solid ${C.border}` }}>Sign in</Link>
          <Link href="/auth/signup" onClick={() => setMenuOpen(false)} style={{ padding: '13px 16px', borderRadius: 8, fontSize: 15, fontWeight: 700, color: '#fff', textDecoration: 'none', textAlign: 'center', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>Start free</Link>
        </div>
      </div>
    </>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section style={{ position: 'relative', zIndex: 10, minHeight: '100svh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', paddingTop: 100, paddingBottom: 80, overflow: 'hidden' }}>
      {/* Ambient glows */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: '16%', left: '50%', transform: 'translateX(-50%)', width: '75%', maxWidth: 760, height: 480, borderRadius: '50%', background: 'radial-gradient(ellipse,rgba(99,102,241,0.11) 0%,transparent 65%)' }} />
        <div style={{ position: 'absolute', top: '28%', left: '10%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle,rgba(139,92,246,0.07) 0%,transparent 65%)' }} />
        <div style={{ position: 'absolute', top: '20%', right: '8%', width: 220, height: 220, borderRadius: '50%', background: 'radial-gradient(circle,rgba(59,130,246,0.06) 0%,transparent 65%)' }} />
      </div>

      <div className="lp-container" style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>

        {/* Status badge */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.06 }} style={{ marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderRadius: 999, border: `1px solid ${C.indigoBd}`, background: C.indigoBg, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#818cf8' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px rgba(74,222,128,0.7)', animation: 'lp-pulse 2s ease-in-out infinite' }} />
            Autonomous AI Software Engineer
          </div>
        </motion.div>

        {/* Headline */}
        <motion.h1 initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.14 }}
          style={{ fontSize: 'clamp(36px,7vw,84px)', fontWeight: 900, lineHeight: 1.04, letterSpacing: '-0.05em', color: C.text, marginBottom: 22, maxWidth: 840 }}>
          Your next app,{' '}
          <span style={{ background: 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 45%,#a78bfa 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
            built autonomously.
          </span>
        </motion.h1>

        {/* Subhead */}
        <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.22 }}
          style={{ fontSize: 'clamp(14px,1.8vw,18px)', color: C.muted, lineHeight: 1.65, maxWidth: 510, marginBottom: 40 }}>
          Describe what you want to build. DWOMOH Vibe Code generates a complete, production-ready Next.js application — then installs, fixes, and verifies every route. Autonomously.
        </motion.p>

        {/* CTA buttons */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.3 }}
          className="lp-hero-btns" style={{ marginBottom: 64 }}>
          <Link href="/auth/signup" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 28px', borderRadius: 12, fontSize: 15, fontWeight: 800, color: '#fff', textDecoration: 'none', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 4px 28px rgba(99,102,241,0.42)', whiteSpace: 'nowrap' }}>
            Start building free <ArrowRight size={16} />
          </Link>
          <Link href="/builder" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 24px', borderRadius: 12, fontSize: 15, fontWeight: 700, color: '#cbd5e1', textDecoration: 'none', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap' }}>
            Open builder
          </Link>
        </motion.div>

        {/* Terminal demo card */}
        <motion.div initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.38 }}
          style={{ width: '100%', maxWidth: 580, borderRadius: 16, overflow: 'hidden', background: 'rgba(6,9,18,0.92)', border: '1px solid rgba(99,102,241,0.18)', boxShadow: '0 32px 72px rgba(0,0,0,0.55)', backdropFilter: 'blur(16px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '11px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.015)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(239,68,68,0.65)' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(234,179,8,0.65)' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(34,197,94,0.55)' }} />
            <span style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#334155', fontWeight: 600 }}>DWOMOH Vibe Code — Builder</span>
          </div>
          <div style={{ padding: '20px 22px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 9 }}>Your prompt</div>
            <div style={{ minHeight: 20 }}><Typewriter /></div>
            <div style={{ marginTop: 18, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              {[['Generate','#6366f1'],['Install','#8b5cf6'],['Self-heal','#f59e0b'],['Verify','#22d3a0'],['Preview','#3b82f6']].map(([l, c]) => (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, boxShadow: `0 0 5px ${c}` }} />
                  <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{l}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.54 }}
          className="lp-hero-stats" style={{ marginTop: 52 }}>
          {[['< 2 min','First preview'],['5 rounds','Self-heal depth'],['3 models','Escalation pipeline'],['100% auto','No manual fixes']].map(([v, l]) => (
            <div key={v} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 900, color: '#818cf8', letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 4 }}>{v}</div>
              <div style={{ fontSize: 11, color: '#475569', fontWeight: 500 }}>{l}</div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Scroll cue */}
      <div aria-hidden="true" style={{ position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', color: '#1e293b', animation: 'lp-scroll 2s ease-in-out infinite' }}>
        <ChevronDown size={20} />
      </div>
    </section>
  );
}

// ── Features ──────────────────────────────────────────────────────────────────

function Features() {
  return (
    <section id="features" style={{ position: 'relative', zIndex: 10, padding: '112px 0' }}>
      <div className="lp-container">
        <div style={{ textAlign: 'center' }}>
          <motion.div {...fadeUp(0)}><Chip label="Capabilities" /></motion.div>
          <motion.h2 {...fadeUp(0.06)} style={{ fontSize: 'clamp(26px,4.5vw,52px)', fontWeight: 900, letterSpacing: '-0.04em', color: C.text, lineHeight: 1.08, marginBottom: 14 }}>
            The complete AI<br />engineering stack
          </motion.h2>
          <motion.p {...fadeUp(0.12)} style={{ fontSize: 16, color: C.muted, lineHeight: 1.6, maxWidth: 420, margin: '0 auto 56px' }}>
            From prompt to verified, live app — every layer of the engineering process automated.
          </motion.p>
        </div>

        <div className="lp-features-grid">
          {FEATURES.map((f, i) => (
            <motion.div key={i} {...fadeUp(i * 0.07)}
              className="lp-feature-card"
              style={{ padding: '26px 24px', borderRadius: 16, background: C.surface, border: `1px solid ${C.border}`, position: 'relative', overflow: 'hidden' }}>
              <div aria-hidden="true" style={{ position: 'absolute', top: 0, right: 0, width: 160, height: 160, background: `radial-gradient(circle at top right,${f.color}10 0%,transparent 65%)`, pointerEvents: 'none' }} />
              <div style={{ width: 42, height: 42, borderRadius: 11, background: `${f.color}18`, border: `1px solid ${f.color}32`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                <f.icon size={19} color={f.color} />
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', marginBottom: 10, letterSpacing: '-0.02em' }}>{f.title}</h3>
              <p style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.72 }}>{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

function Pipeline() {
  return (
    <section id="pipeline" style={{ position: 'relative', zIndex: 10, padding: '112px 0', background: 'rgba(4,6,14,0.55)' }}>
      <div className="lp-container">
        <div style={{ textAlign: 'center' }}>
          <motion.div {...fadeUp(0)}><Chip label="How It Works" /></motion.div>
          <motion.h2 {...fadeUp(0.06)} style={{ fontSize: 'clamp(26px,4.5vw,52px)', fontWeight: 900, letterSpacing: '-0.04em', color: C.text, lineHeight: 1.08, marginBottom: 56 }}>
            The self-healing<br />build pipeline
          </motion.h2>
        </div>

        <div className="lp-pipeline-grid">
          {PIPELINE.map((p, i) => (
            <motion.div key={i} {...fadeUp(i * 0.07)}
              className="lp-pipeline-card"
              style={{ padding: '22px', borderRadius: 14, background: 'rgba(5,8,16,0.92)', border: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.26)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 9, fontWeight: 900, color: '#818cf8', letterSpacing: '0.04em' }}>{p.n}</span>
                </div>
                <h3 style={{ fontSize: 14, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>{p.label}</h3>
              </div>
              <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.72 }}>{p.body}</p>
            </motion.div>
          ))}
        </div>

        <motion.div {...fadeUp(0.2)}
          className="lp-pipeline-stats"
          style={{ marginTop: 44, borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(99,102,241,0.12)', background: 'rgba(99,102,241,0.04)' }}>
          {[['5 rounds','Self-heal depth'],['3 models','Haiku → Sonnet → Opus'],['100% auto','Zero manual fixes'],['Real browser','Playwright verified']].map(([v, l], i) => (
            <div key={i} style={{ padding: '22px 16px', textAlign: 'center', borderLeft: i > 0 ? '1px solid rgba(99,102,241,0.1)' : 'none' }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: '#818cf8', letterSpacing: '-0.03em', marginBottom: 4 }}>{v}</div>
              <div style={{ fontSize: 11, color: '#475569', fontWeight: 500 }}>{l}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

// ── Pricing ───────────────────────────────────────────────────────────────────

function Pricing() {
  return (
    <section id="pricing" style={{ position: 'relative', zIndex: 10, padding: '112px 0' }}>
      <div className="lp-container">
        <div style={{ textAlign: 'center' }}>
          <motion.div {...fadeUp(0)}><Chip label="Pricing" /></motion.div>
          <motion.h2 {...fadeUp(0.06)} style={{ fontSize: 'clamp(26px,4.5vw,52px)', fontWeight: 900, letterSpacing: '-0.04em', color: C.text, lineHeight: 1.08, marginBottom: 12 }}>
            Simple pricing.<br />No surprises.
          </motion.h2>
          <motion.p {...fadeUp(0.12)} style={{ fontSize: 16, color: C.muted, marginBottom: 56 }}>Start free. Upgrade when you need more.</motion.p>
        </div>

        <div className="lp-pricing-grid">
          {PLANS.map((plan, i) => (
            <motion.div key={plan.id} {...fadeUp(i * 0.08)}
              className="lp-pricing-card"
              style={{ padding: '26px 22px', borderRadius: 16, position: 'relative', background: plan.highlight ? 'linear-gradient(160deg,rgba(99,102,241,0.11),rgba(139,92,246,0.06))' : C.surface, border: `1px solid ${plan.highlight ? 'rgba(99,102,241,0.4)' : C.border}`, boxShadow: plan.highlight ? '0 0 56px rgba(99,102,241,0.1)' : 'none' }}>
              {'badge' in plan && (plan as { badge?: string }).badge && (
                <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', padding: '4px 13px', borderRadius: 999, fontSize: 10, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 4px 12px rgba(99,102,241,0.4)' }}>
                  {(plan as { badge?: string }).badge}
                </div>
              )}
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>{plan.name}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginBottom: 6 }}>
                  <span style={{ fontSize: 42, fontWeight: 900, color: C.text, letterSpacing: '-0.05em', lineHeight: 1 }}>{plan.price}</span>
                  <span style={{ fontSize: 14, color: '#475569', fontWeight: 600 }}>{plan.period}</span>
                </div>
                <div style={{ fontSize: 12.5, color: '#475569' }}>{plan.desc}</div>
              </div>
              <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {plan.features.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                    <Check size={12} color={plan.highlight ? '#a5b4fc' : C.indigo} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.5 }}>{f}</span>
                  </div>
                ))}
              </div>
              <Link href={plan.href} style={{ display: 'block', textAlign: 'center', padding: '11px 16px', borderRadius: 10, fontSize: 13.5, fontWeight: 800, color: '#fff', textDecoration: 'none', background: plan.highlight ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'rgba(255,255,255,0.05)', border: plan.highlight ? 'none' : '1px solid rgba(255,255,255,0.09)', boxShadow: plan.highlight ? '0 4px 16px rgba(99,102,241,0.35)' : 'none' }}>
                {plan.cta}
              </Link>
            </motion.div>
          ))}
        </div>
        <p style={{ textAlign: 'center', marginTop: 28, fontSize: 13, color: C.dim }}>
          African payments via Paystack — MTN MoMo, M-Pesa, Vodafone Cash, local bank transfer.
        </p>
      </div>
    </section>
  );
}

// ── FAQ ───────────────────────────────────────────────────────────────────────

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section id="faq" style={{ position: 'relative', zIndex: 10, padding: '112px 0', background: 'rgba(4,6,14,0.5)' }}>
      <div className="lp-container">
        <div style={{ textAlign: 'center' }}>
          <motion.div {...fadeUp(0)}><Chip label="FAQ" /></motion.div>
          <motion.h2 {...fadeUp(0.06)} style={{ fontSize: 'clamp(26px,4vw,48px)', fontWeight: 900, letterSpacing: '-0.04em', color: C.text, marginBottom: 48 }}>
            Questions answered
          </motion.h2>
        </div>

        <div style={{ maxWidth: 660, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FAQ_ITEMS.map((item, i) => (
            <motion.div key={i} {...fadeUp(i * 0.05)} style={{ borderRadius: 12, overflow: 'hidden', background: C.surface, border: `1px solid ${C.border}` }}>
              <button onClick={() => setOpen(open === i ? null : i)} className="lp-faq-btn"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '17px 20px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: '#e2e8f0', lineHeight: 1.4 }}>{item.q}</span>
                <motion.span animate={{ rotate: open === i ? 45 : 0 }} transition={{ duration: 0.18 }} style={{ flexShrink: 0 }}>
                  <Plus size={15} color={C.indigo} />
                </motion.span>
              </button>
              <AnimatePresence>
                {open === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} style={{ overflow: 'hidden' }}>
                    <div style={{ padding: '0 20px 16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <p style={{ paddingTop: 14, fontSize: 13.5, color: '#475569', lineHeight: 1.72 }}>{item.a}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── CTA ───────────────────────────────────────────────────────────────────────

function CTA() {
  return (
    <section style={{ position: 'relative', zIndex: 10, padding: '132px 0', textAlign: 'center', overflow: 'hidden' }}>
      <div aria-hidden="true" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 560, height: 380, borderRadius: '50%', background: 'radial-gradient(ellipse,rgba(99,102,241,0.09) 0%,transparent 65%)', pointerEvents: 'none' }} />
      <div className="lp-container" style={{ position: 'relative' }}>
        <motion.div {...fadeUp(0)} style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.indigoBg, border: `1px solid ${C.indigoBd}` }}>
            <Zap size={24} color="#818cf8" />
          </div>
        </motion.div>
        <motion.h2 {...fadeUp(0.07)} style={{ fontSize: 'clamp(30px,5vw,64px)', fontWeight: 900, letterSpacing: '-0.05em', lineHeight: 1.06, color: C.text, marginBottom: 18 }}>
          Your next app starts<br />
          <span style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6,#a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
            with one sentence
          </span>
        </motion.h2>
        <motion.p {...fadeUp(0.14)} style={{ fontSize: 16, color: C.muted, marginBottom: 40, lineHeight: 1.6 }}>
          Join builders across Africa and the world shipping production-ready apps.
        </motion.p>
        <motion.div {...fadeUp(0.2)}>
          <Link href="/auth/signup" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '14px 32px', borderRadius: 12, fontSize: 15, fontWeight: 800, color: '#fff', textDecoration: 'none', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 6px 36px rgba(99,102,241,0.44)' }}>
            Start building free <ArrowRight size={16} />
          </Link>
        </motion.div>
        <p style={{ marginTop: 18, fontSize: 12.5, color: C.dim }}>Free plan · No credit card · 3 full generations</p>
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer style={{ position: 'relative', zIndex: 10, borderTop: `1px solid ${C.border}`, background: 'rgba(3,4,10,0.92)', padding: '60px 0 28px' }}>
      <div className="lp-container">
        <div className="lp-footer-grid" style={{ marginBottom: 44 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap size={13} color="#fff" />
              </div>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#f1f5f9' }}>DWOMOH Vibe Code</span>
            </div>
            <p style={{ fontSize: 12.5, color: C.dim, lineHeight: 1.65, maxWidth: 200 }}>Autonomous AI software engineer. Describe it, build it, ship it.</p>
            <p style={{ fontSize: 11, color: '#1e293b', marginTop: 10 }}>Founded by Bright Dwomoh, Ghana 🇬🇭</p>
          </div>
          {[
            { title: 'Product', links: [['Features','#features'],['How It Works','#pipeline'],['Pricing','#pricing']] as const },
            { title: 'Builder', links: [['Open Builder','/builder'],['Sign In','/auth/signin'],['Create Account','/auth/signup']] as const },
            { title: 'Legal',   links: [['Privacy','#'],['Terms','#']] as const },
          ].map(col => (
            <div key={col.title}>
              <div style={{ fontSize: 9, fontWeight: 800, color: C.dim, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 14 }}>{col.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {col.links.map(([l, h]) => (
                  <a key={l} href={h} className="lp-footer-link" style={{ fontSize: 12.5, color: C.dim, textDecoration: 'none' }}>{l}</a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ fontSize: 11, color: '#1e293b' }}>© 2026 DWOMOH Vibe Code. All rights reserved.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#1e293b' }}>Payments via</span>
            {['Stripe','Paystack','MTN MoMo','M-Pesa'].map(p => (
              <span key={p} style={{ padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, color: C.dim, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>{p}</span>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="lp-wrap">
      <ThreeBackground intensity={0.85} />
      <NavBar />
      <main>
        <Hero />
        <Features />
        <Pipeline />
        <Pricing />
        <FAQSection />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
