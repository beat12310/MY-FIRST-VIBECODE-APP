'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PLANS_LIST, type PlanId } from '@/lib/subscription-plans';

interface SubData {
  planId: PlanId;
  generationsUsedThisMonth: number;
  billingCycleStart: string;
  stripeCustomerId: string | null;
  paystackCustomerCode: string | null;
}

function BillingContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [sub, setSub] = useState<SubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [provider, setProvider] = useState<'stripe' | 'paystack'>('stripe');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (searchParams?.get('success')) setNotice('✅ Payment successful! Your plan has been upgraded.');
    if (searchParams?.get('error')) setNotice(`❌ ${searchParams.get('error')}`);
  }, [searchParams]);

  useEffect(() => {
    if (!user) return;
    fetch(`/api/subscription?userId=${user.userId}`)
      .then(r => r.json())
      .then(setSub)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  async function handleUpgrade(planId: PlanId) {
    if (!user || planId === 'free') return;
    setCheckoutLoading(planId);
    try {
      const res = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: provider === 'stripe' ? 'create-checkout-stripe' : 'create-checkout-paystack',
          userId: user.userId,
          email: user.email,
          planId,
          successUrl:   `${window.location.origin}/dashboard/billing`,
          cancelUrl:    `${window.location.origin}/dashboard/billing`,
          callbackUrl:  `${window.location.origin}/api/billing/paystack/verify`,
        }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        setNotice(`❌ ${data.error}`);
      }
    } catch (e) {
      setNotice(`❌ ${(e as Error).message}`);
    } finally {
      setCheckoutLoading(null);
    }
  }

  const currentPlan = PLANS_LIST.find(p => p.id === (sub?.planId ?? 'free')) ?? PLANS_LIST[0];
  const used = sub?.generationsUsedThisMonth ?? 0;
  const limit = currentPlan.limits.generationsPerMonth;
  const pct = Math.min(100, (used / (limit === 999 ? 999 : limit)) * 100);

  return (
    <div style={{ color: '#f8fafc', maxWidth: 860 }}>
      <div style={{ marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 6 }}>Billing & Subscription</h1>
        <p style={{ color: '#64748b', fontSize: 15 }}>Manage your plan, usage, and payment method.</p>
      </div>

      {notice && (
        <div style={{
          background: notice.startsWith('✅') ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${notice.startsWith('✅') ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          borderRadius: 10, padding: '12px 18px', marginBottom: 28,
          color: notice.startsWith('✅') ? '#86efac' : '#fca5a5', fontSize: 14,
        }}>
          {notice}
        </div>
      )}

      {/* Current plan summary */}
      {!loading && (
        <div style={{ background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 28, marginBottom: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Current plan</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{currentPlan.name}</div>
              <div style={{ fontSize: 14, color: '#64748b', marginTop: 4 }}>{currentPlan.priceMonthly}/month</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Billing cycle resets</div>
              <div style={{ fontSize: 14, color: '#94a3b8' }}>
                {sub?.billingCycleStart
                  ? new Date(new Date(sub.billingCycleStart).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  : '—'}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>Generations this month</span>
              <span style={{ fontSize: 13, color: '#f8fafc', fontWeight: 600 }}>{used} / {limit === 999 ? '∞' : limit}</span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 100, height: 8, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, borderRadius: 100, background: pct > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#8b5cf6,#6366f1)', transition: 'width 0.4s' }} />
            </div>
          </div>
        </div>
      )}

      {/* Payment provider selector */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Payment method</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {([
            { id: 'stripe', label: '💳 Card (Stripe)', sub: 'Visa, Mastercard, global' },
            { id: 'paystack', label: '🌍 Paystack', sub: 'MTN MoMo, M-Pesa, bank transfer' },
          ] as const).map(p => (
            <button
              key={p.id}
              onClick={() => setProvider(p.id)}
              style={{
                flex: 1, padding: '14px 18px', borderRadius: 10, border: '1px solid',
                borderColor: provider === p.id ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.08)',
                background: provider === p.id ? 'rgba(139,92,246,0.1)' : 'rgba(255,255,255,0.02)',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: provider === p.id ? '#a78bfa' : '#94a3b8' }}>{p.label}</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>{p.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc', marginBottom: 18 }}>Choose a plan</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 16, marginBottom: 32 }}>
        {PLANS_LIST.map(plan => {
          const isCurrent = plan.id === (sub?.planId ?? 'free');
          return (
            <div key={plan.id} style={{
              background: plan.highlighted ? 'linear-gradient(160deg,rgba(139,92,246,0.13),rgba(99,102,241,0.08))' : 'rgba(15,15,25,0.6)',
              border: `1px solid ${isCurrent ? 'rgba(34,197,94,0.4)' : plan.highlighted ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16, padding: 22, position: 'relative',
            }}>
              {isCurrent && (
                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: '#16a34a', color: '#fff', padding: '3px 12px', borderRadius: 100, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  Current
                </div>
              )}
              {plan.badge && !isCurrent && (
                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '3px 12px', borderRadius: 100, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {plan.badge}
                </div>
              )}
              <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>{plan.name}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 14 }}>
                <span style={{ fontSize: 24, fontWeight: 800 }}>{plan.priceMonthly}</span>
                <span style={{ fontSize: 12, color: '#64748b' }}>/mo</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {plan.features.slice(0, 3).map(f => (
                  <div key={f} style={{ display: 'flex', gap: 6 }}>
                    <span style={{ color: '#8b5cf6' }}>✓</span>
                    <span style={{ color: '#94a3b8' }}>{f}</span>
                  </div>
                ))}
              </div>
              <button
                disabled={isCurrent || !!checkoutLoading}
                onClick={() => !isCurrent && plan.id !== 'free' && handleUpgrade(plan.id)}
                style={{
                  width: '100%', padding: '9px', borderRadius: 8, border: 'none',
                  cursor: isCurrent || plan.id === 'free' ? 'default' : checkoutLoading ? 'wait' : 'pointer',
                  background: isCurrent ? 'rgba(34,197,94,0.1)' : plan.highlighted ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(255,255,255,0.06)',
                  color: isCurrent ? '#4ade80' : '#fff',
                  fontSize: 13, fontWeight: 600, opacity: checkoutLoading && checkoutLoading !== plan.id ? 0.5 : 1,
                }}
              >
                {isCurrent ? 'Current plan' : checkoutLoading === plan.id ? 'Redirecting…' : plan.price === 0 ? 'Free' : `Upgrade to ${plan.name}`}
              </button>
            </div>
          );
        })}
      </div>

      {/* Setup note */}
      <div style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.12)', borderRadius: 12, padding: '18px 22px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa', marginBottom: 8 }}>Billing setup required</div>
        <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7, marginBottom: 0 }}>
          Add these keys to <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4 }}>.env.local</code> to activate payments:
        </p>
        <pre style={{ marginTop: 10, fontSize: 12, color: '#94a3b8', background: 'rgba(0,0,0,0.3)', padding: '12px 16px', borderRadius: 8, overflow: 'auto', lineHeight: 1.7 }}>
{`# Stripe (global cards)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_BUSINESS_PRICE_ID=price_...

# Paystack (Africa — MTN MoMo, M-Pesa, bank transfer)
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_STARTER_PLAN=PLN_...
PAYSTACK_PRO_PLAN=PLN_...
PAYSTACK_BUSINESS_PLAN=PLN_...`}
        </pre>
      </div>
    </div>
  );
}

export default function BillingPage() {
  return <Suspense><BillingContent /></Suspense>;
}
