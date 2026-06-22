'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'FAQ', href: '#faq' },
];

const FEATURES = [
  {
    icon: '⚡',
    title: 'Instant AI Generation',
    desc: 'Describe any app and DWOMOH Vibe Code generates a full Next.js project with TypeScript, Tailwind CSS, and working APIs — in under two minutes.',
  },
  {
    icon: '📦',
    title: 'Autonomous Dependency Install',
    desc: 'The platform scans your generated code, detects every import, installs missing packages automatically, and retries until everything resolves.',
  },
  {
    icon: '🔍',
    title: 'Self-Healing Build Pipeline',
    desc: 'TypeScript errors, missing env vars, broken imports — a 5-round verification loop diagnoses and patches each issue without you lifting a finger.',
  },
  {
    icon: '🚀',
    title: 'One-Click Preview',
    desc: 'Your app spins up on a live development server with hot-reload. See it in the preview panel the moment Next.js compilation completes.',
  },
  {
    icon: '🔐',
    title: 'Auth Out of the Box',
    desc: 'Generate apps with authentication pre-configured — NextAuth routes, session providers, and environment secrets handled automatically.',
  },
  {
    icon: '📤',
    title: 'Export & Deploy',
    desc: 'Download production-ready source code or deploy directly to the web. Pro users get custom domain support and branding-free output.',
  },
];

const TESTIMONIALS = [
  {
    quote: 'I shipped a fully functional SaaS MVP in one afternoon. The self-healing build pipeline is genuinely magical — it fixed TypeScript errors I did not even know I had.',
    name: 'Kwame Asante',
    role: 'Founder, TechHub Accra',
    avatar: 'KA',
  },
  {
    quote: 'As someone who designs but does not code, DWOMOH Vibe Code lets me prototype real apps and hand working code to developers. Game-changing for our team.',
    name: 'Ama Mensah',
    role: 'Product Designer, Kofa Energy',
    avatar: 'AM',
  },
  {
    quote: 'We generated our internal inventory tool in 45 minutes. The authentication setup was automatic — something that used to take us days.',
    name: 'Chidi Obi',
    role: 'CTO, Logistics Connect',
    avatar: 'CO',
  },
];

const FAQ_ITEMS = [
  {
    q: 'What kinds of apps can DWOMOH Vibe Code generate?',
    a: 'Any web application: dashboards, e-commerce stores, music platforms, CRMs, SaaS tools, landing pages, APIs, and more. The AI generates complete Next.js projects with TypeScript, Tailwind CSS, API routes, mock data, and authentication.',
  },
  {
    q: 'Do I need to know how to code?',
    a: 'Not at all. Just describe what you want in plain English. DWOMOH Vibe Code handles code generation, dependency installation, TypeScript fixes, and live preview automatically.',
  },
  {
    q: 'What is a generation?',
    a: 'One generation is one complete app built from your description. The AI writes all the files, installs packages, fixes errors, and verifies the preview — that entire flow counts as one generation.',
  },
  {
    q: 'Can I export my code and use it outside the platform?',
    a: 'Yes. Starter plan and above lets you download your full project as a zip or copy the source code. The output is standard Next.js — no lock-in.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'We support major cards via Stripe globally, and Paystack for African payments including mobile money (M-Pesa, MTN MoMo) and local bank transfers.',
  },
  {
    q: 'Is there a free trial for paid plans?',
    a: 'The Free plan gives you 3 full generations at no cost — no credit card required. You can experience the complete pipeline before upgrading.',
  },
];

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '',
    desc: 'Try the magic. No card needed.',
    features: ['3 generations per month', 'Live preview', 'Community support', 'DWOMOH branding'],
    cta: 'Start Free',
    ctaHref: '/auth/signup',
    highlight: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$9',
    period: '/mo',
    desc: 'For solo builders shipping side projects.',
    features: ['20 generations per month', 'Save & manage projects', 'Export source code', 'Email support'],
    cta: 'Get Starter',
    ctaHref: '/auth/signup?plan=starter',
    highlight: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$19',
    period: '/mo',
    desc: 'For professionals who ship fast.',
    features: ['80 generations per month', 'Deploy apps', 'Custom domains', 'Remove branding', 'Priority support'],
    cta: 'Go Pro',
    ctaHref: '/auth/signup?plan=pro',
    highlight: true,
    badge: 'Most Popular',
  },
  {
    id: 'business',
    name: 'Business',
    price: '$49',
    period: '/mo',
    desc: 'For teams moving at startup speed.',
    features: ['Unlimited generations', 'Team collaboration', 'Priority queue', 'Dedicated support', 'Advanced analytics'],
    cta: 'Get Business',
    ctaHref: '/auth/signup?plan=business',
    highlight: false,
  },
];

function NavBar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
      transition: 'all 0.2s',
      background: scrolled ? 'rgba(6,6,12,0.95)' : 'transparent',
      backdropFilter: scrolled ? 'blur(12px)' : 'none',
      borderBottom: scrolled ? '1px solid rgba(139,92,246,0.15)' : 'none',
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', height: 64 }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <div style={{ width: 32, height: 32, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>⚡</div>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.02em' }}>DWOMOH Vibe Code</span>
        </Link>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
          {NAV_LINKS.map(l => (
            <a key={l.href} href={l.href} style={{ color: '#94a3b8', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}>
              {l.label}
            </a>
          ))}
          <Link href="/auth/signin" style={{ color: '#94a3b8', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}>Sign in</Link>
          <Link href="/auth/signup" style={{
            background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
            padding: '8px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600,
            textDecoration: 'none',
          }}>
            Start for free
          </Link>
        </div>
      </div>
    </nav>
  );
}

function HeroSection() {
  const phrases = [
    'a Boomplay-style music store',
    'a SaaS dashboard with auth',
    'an e-commerce platform',
    'a CRM with dark theme',
    'an inventory management app',
  ];
  const [typed, setTyped] = useState('');
  const phraseIdx = useRef(0);
  const charIdx = useRef(0);
  const deleting = useRef(false);
  const pauseRef = useRef(false);

  useEffect(() => {
    let raf: number;
    let lastTime = 0;
    const delay = () => deleting.current ? 35 : 65;

    function tick(now: number) {
      if (pauseRef.current) { raf = requestAnimationFrame(tick); return; }
      if (now - lastTime < delay()) { raf = requestAnimationFrame(tick); return; }
      lastTime = now;

      const phrase = phrases[phraseIdx.current];
      if (!deleting.current) {
        charIdx.current = Math.min(charIdx.current + 1, phrase.length);
        setTyped(phrase.slice(0, charIdx.current));
        if (charIdx.current === phrase.length) {
          pauseRef.current = true;
          setTimeout(() => { pauseRef.current = false; deleting.current = true; }, 1800);
        }
      } else {
        charIdx.current = Math.max(charIdx.current - 1, 0);
        setTyped(phrase.slice(0, charIdx.current));
        if (charIdx.current === 0) {
          deleting.current = false;
          phraseIdx.current = (phraseIdx.current + 1) % phrases.length;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', padding: '120px 24px 80px',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)', width: 700, height: 700, background: 'radial-gradient(circle, rgba(139,92,246,0.11) 0%, transparent 70%)', pointerEvents: 'none' }} />

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 100, padding: '6px 16px', marginBottom: 32 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', display: 'inline-block' }} />
        <span style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600 }}>AI-Powered App Builder</span>
      </div>

      <h1 style={{ fontSize: 'clamp(40px,7vw,80px)', fontWeight: 800, lineHeight: 1.08, letterSpacing: '-0.04em', marginBottom: 24, maxWidth: 900 }}>
        <span style={{ color: '#f8fafc' }}>Build </span>
        <span style={{ background: 'linear-gradient(135deg,#8b5cf6,#6366f1,#a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>real apps</span>
        <br />
        <span style={{ color: '#f8fafc' }}>with a single sentence</span>
      </h1>

      <p style={{ fontSize: 18, color: '#94a3b8', maxWidth: 560, lineHeight: 1.65, marginBottom: 48 }}>
        Describe what you want to build. DWOMOH Vibe Code generates, installs, fixes,
        and previews a full production-ready Next.js app — autonomously.
      </p>

      <div style={{ display: 'flex', gap: 16, marginBottom: 64, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/auth/signup" style={{
          background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
          padding: '14px 32px', borderRadius: 10, fontSize: 16, fontWeight: 700,
          textDecoration: 'none', boxShadow: '0 0 40px rgba(139,92,246,0.3)',
        }}>
          Start building free
        </Link>
        <a href="#features" style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
          color: '#f8fafc', padding: '14px 32px', borderRadius: 10, fontSize: 16, fontWeight: 600,
          textDecoration: 'none',
        }}>
          See how it works
        </a>
      </div>

      <div style={{ background: 'rgba(15,15,25,0.8)', border: '1px solid rgba(139,92,246,0.25)', borderRadius: 14, padding: '20px 28px', maxWidth: 640, width: '100%', textAlign: 'left' }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Try saying:</div>
        <div style={{ fontSize: 16, color: '#f8fafc', fontFamily: 'monospace', minHeight: 24 }}>
          Build me{' '}
          <span style={{ color: '#a78bfa' }}>{typed}<span style={{ opacity: 0.5 }}>|</span></span>
        </div>
      </div>

      <div style={{ marginTop: 60, display: 'flex', gap: 48, flexWrap: 'wrap', justifyContent: 'center' }}>
        {[['< 2 min', 'to first preview'], ['5-round', 'self-healing loop'], ['100%', 'real Next.js code']].map(([stat, label]) => (
          <div key={stat} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#a78bfa' }}>{stat}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FeaturesSection() {
  return (
    <section id="features" style={{ padding: '100px 24px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 72 }}>
          <h2 style={{ fontSize: 'clamp(32px,5vw,52px)', fontWeight: 800, letterSpacing: '-0.03em', color: '#f8fafc', marginBottom: 16 }}>
            Everything you need to ship
          </h2>
          <p style={{ color: '#94a3b8', fontSize: 17, maxWidth: 500, margin: '0 auto' }}>
            The complete AI builder pipeline — from prompt to production.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 24 }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{
              background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 16, padding: 32, transition: 'border-color 0.2s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.4)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}>
              <div style={{ fontSize: 32, marginBottom: 16 }}>{f.icon}</div>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc', marginBottom: 10 }}>{f.title}</h3>
              <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.65 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section id="pricing" style={{ padding: '100px 24px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 72 }}>
          <h2 style={{ fontSize: 'clamp(32px,5vw,52px)', fontWeight: 800, letterSpacing: '-0.03em', color: '#f8fafc', marginBottom: 16 }}>
            Simple, transparent pricing
          </h2>
          <p style={{ color: '#94a3b8', fontSize: 17 }}>Start free. Scale when you are ready.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 20 }}>
          {PLANS.map(plan => (
            <div key={plan.id} style={{
              background: plan.highlight ? 'linear-gradient(160deg,rgba(139,92,246,0.15),rgba(99,102,241,0.1))' : 'rgba(15,15,25,0.6)',
              border: plan.highlight ? '1px solid rgba(139,92,246,0.5)' : '1px solid rgba(255,255,255,0.07)',
              borderRadius: 20, padding: 32, position: 'relative',
              boxShadow: plan.highlight ? '0 0 60px rgba(139,92,246,0.15)' : 'none',
            }}>
              {plan.badge && (
                <div style={{
                  position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                  background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
                  padding: '4px 14px', borderRadius: 100, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                }}>
                  {plan.badge}
                </div>
              )}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>{plan.name}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 8 }}>
                  <span style={{ fontSize: 42, fontWeight: 800, color: '#f8fafc' }}>{plan.price}</span>
                  <span style={{ fontSize: 15, color: '#64748b' }}>{plan.period}</span>
                </div>
                <div style={{ fontSize: 13, color: '#64748b' }}>{plan.desc}</div>
              </div>

              <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {plan.features.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ color: '#8b5cf6', flexShrink: 0 }}>✓</span>
                    <span style={{ fontSize: 14, color: '#cbd5e1' }}>{f}</span>
                  </div>
                ))}
              </div>

              <Link href={plan.ctaHref} style={{
                display: 'block', textAlign: 'center',
                background: plan.highlight ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(255,255,255,0.06)',
                border: plan.highlight ? 'none' : '1px solid rgba(255,255,255,0.1)',
                color: '#fff', padding: '12px 20px', borderRadius: 10,
                fontSize: 14, fontWeight: 700, textDecoration: 'none',
              }}>
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>

        <p style={{ textAlign: 'center', marginTop: 40, color: '#64748b', fontSize: 14 }}>
          African payments supported via Paystack — MTN MoMo, M-Pesa, bank transfer, and more.
        </p>
      </div>
    </section>
  );
}

function TestimonialsSection() {
  return (
    <section style={{ padding: '100px 24px', background: 'rgba(8,8,16,0.6)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 style={{ fontSize: 'clamp(28px,4vw,44px)', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em', marginBottom: 12 }}>
            Builders love DWOMOH Vibe Code
          </h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 24 }}>
          {TESTIMONIALS.map((t, i) => (
            <div key={i} style={{
              background: 'rgba(15,15,28,0.8)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 16, padding: 32,
            }}>
              <div style={{ color: '#8b5cf6', fontSize: 32, marginBottom: 16, lineHeight: 1 }}>&ldquo;</div>
              <p style={{ color: '#cbd5e1', fontSize: 15, lineHeight: 1.7, marginBottom: 24 }}>{t.quote}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: '#fff',
                }}>
                  {t.avatar}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc' }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section id="faq" style={{ padding: '100px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 style={{ fontSize: 'clamp(28px,4vw,44px)', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.03em' }}>
            Frequently asked questions
          </h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {FAQ_ITEMS.map((item, i) => (
            <div key={i} style={{
              background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 12, overflow: 'hidden',
            }}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                style={{
                  width: '100%', textAlign: 'left', padding: '20px 24px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
                }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: '#f8fafc' }}>{item.q}</span>
                <span style={{ color: '#8b5cf6', fontSize: 20, transition: 'transform 0.2s', transform: open === i ? 'rotate(45deg)' : 'none', flexShrink: 0 }}>+</span>
              </button>
              {open === i && (
                <div style={{ padding: '0 24px 20px' }}>
                  <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section style={{ padding: '100px 24px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 600, height: 400, background: 'radial-gradient(ellipse, rgba(139,92,246,0.12) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ position: 'relative', maxWidth: 640, margin: '0 auto' }}>
        <h2 style={{ fontSize: 'clamp(32px,5vw,56px)', fontWeight: 800, letterSpacing: '-0.04em', color: '#f8fafc', marginBottom: 20 }}>
          Your next app starts<br />
          <span style={{ background: 'linear-gradient(135deg,#8b5cf6,#6366f1,#a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            with one sentence
          </span>
        </h2>
        <p style={{ color: '#94a3b8', fontSize: 17, marginBottom: 40, lineHeight: 1.6 }}>
          Join builders across Africa and beyond who are shipping with DWOMOH Vibe Code.
        </p>
        <Link href="/auth/signup" style={{
          display: 'inline-block',
          background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
          padding: '16px 36px', borderRadius: 12, fontSize: 16, fontWeight: 700,
          textDecoration: 'none', boxShadow: '0 0 40px rgba(139,92,246,0.35)',
        }}>
          Start building — it is free
        </Link>
        <p style={{ marginTop: 20, color: '#475569', fontSize: 13 }}>No credit card required. 3 free generations.</p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '40px 24px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>⚡</div>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8' }}>DWOMOH Vibe Code</span>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          {['Privacy', 'Terms', 'Support'].map(l => (
            <a key={l} href="#" style={{ color: '#64748b', fontSize: 13, textDecoration: 'none' }}>{l}</a>
          ))}
        </div>
        <div style={{ color: '#475569', fontSize: 13 }}>
          &copy; 2026 DWOMOH Vibe Code. All rights reserved.
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#06060c', color: '#f8fafc', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' }}>
      <NavBar />
      <HeroSection />
      <FeaturesSection />
      <PricingSection />
      <TestimonialsSection />
      <FAQSection />
      <CTASection />
      <Footer />
    </div>
  );
}
