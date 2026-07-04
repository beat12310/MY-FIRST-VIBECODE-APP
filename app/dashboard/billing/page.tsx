'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PLANS_LIST, type PlanId } from '@/lib/subscription-plans';
import { CURRENCIES, priceInCurrency } from '@/lib/billing-config';

interface StatusData {
  balance: number;
  subscription: { planId: PlanId; status: string; currentPeriodEnd: string | null; active: boolean };
  deploy: { allowed: boolean; reason?: string };
}

function BillingContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [provider, setProvider] = useState<'stripe' | 'paystack'>('paystack');
  const [currency, setCurrency] = useState<string>('USD');
  const [topUpUsd, setTopUpUsd] = useState<number>(10);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (searchParams?.get('success')) setNotice('✅ Payment received. Your balance/subscription updates once Paystack confirms (a few seconds).');
    if (searchParams?.get('error')) setNotice(`❌ ${searchParams.get('error')}`);
  }, [searchParams]);

  function refreshStatus() {
    if (!user) return;
    fetch('/api/billing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', userId: user.userId, email: user.email }),
    }).then(r => r.json()).then(setStatus).catch(() => {}).finally(() => setLoading(false));
  }
  useEffect(refreshStatus, [user]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch('/api/billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json() as Promise<{ url?: string; error?: string }>;
  }

  async function handleSubscribe(planId: PlanId) {
    if (!user || planId === 'free') return;
    setCheckoutLoading(planId);
    try {
      const data = await post({
        action: provider === 'stripe' ? 'create-checkout-stripe' : 'subscribe',
        userId: user.userId, email: user.email, planId, currency,
        successUrl: `${window.location.origin}/dashboard/billing`,
        cancelUrl: `${window.location.origin}/dashboard/billing`,
        callbackUrl: `${window.location.origin}/api/billing/paystack/verify`,
      });
      if (data.url) window.location.href = data.url; else setNotice(`❌ ${data.error}`);
    } catch (e) { setNotice(`❌ ${(e as Error).message}`); } finally { setCheckoutLoading(null); }
  }

  async function handleTopUp() {
    if (!user) return;
    setCheckoutLoading('topup');
    try {
      const data = await post({
        action: 'topup', userId: user.userId, email: user.email, amountUsd: topUpUsd, currency,
        callbackUrl: `${window.location.origin}/dashboard/billing`,
      });
      if (data.url) window.location.href = data.url; else setNotice(`❌ ${data.error}`);
    } catch (e) { setNotice(`❌ ${(e as Error).message}`); } finally { setCheckoutLoading(null); }
  }

  const planId = status?.subscription.planId ?? 'free';
  const currentPlan = PLANS_LIST.find(p => p.id === planId) ?? PLANS_LIST[0];
  const cur = CURRENCIES[currency] ?? CURRENCIES.USD;
  const fmt = (usd: number) => priceInCurrency(usd, currency).display;
  const renews = status?.subscription.currentPeriodEnd
    ? new Date(status.subscription.currentPeriodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const subActive = status?.subscription.active;

  const card = { background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 28 } as const;

  return (
    <div style={{ color: '#f8fafc', maxWidth: 860 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 6 }}>Billing & Credits</h1>
        <p style={{ color: '#64748b', fontSize: 15 }}>Manage your credits, subscription, and payment method.</p>
      </div>

      {notice && (
        <div style={{
          background: notice.startsWith('✅') ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${notice.startsWith('✅') ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          borderRadius: 10, padding: '12px 18px', marginBottom: 24,
          color: notice.startsWith('✅') ? '#86efac' : '#fca5a5', fontSize: 14,
        }}>{notice}</div>
      )}

      {/* ── Status row: credits · subscription · deploy access ── */}
      {!loading && status && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16, marginBottom: 24 }}>
          {/* Credit balance + top-up */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Credit balance</div>
            <div style={{ fontSize: 30, fontWeight: 800 }}>{status.balance} <span style={{ fontSize: 14, color: '#64748b', fontWeight: 600 }}>credits</span></div>
            <div style={{ fontSize: 12, color: '#64748b', margin: '4px 0 14px' }}>1 credit = $1 · 1 generation = 1 credit</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={topUpUsd} onChange={e => setTopUpUsd(Number(e.target.value))}
                style={{ flex: 1, background: 'rgba(0,0,0,0.3)', color: '#f8fafc', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
                {[5, 10, 20, 50, 100].map(v => <option key={v} value={v}>{fmt(v)} ({v} credits)</option>)}
              </select>
              <button onClick={handleTopUp} disabled={!!checkoutLoading}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: checkoutLoading ? 'wait' : 'pointer', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {checkoutLoading === 'topup' ? '…' : 'Top up'}
              </button>
            </div>
          </div>

          {/* Subscription status */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Subscription</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{currentPlan.name}</div>
            <div style={{ display: 'inline-block', marginTop: 8, padding: '3px 10px', borderRadius: 100, fontSize: 12, fontWeight: 700,
              background: subActive ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)', color: subActive ? '#4ade80' : '#94a3b8' }}>
              {subActive ? 'Active' : (status.subscription.status === 'expired' ? 'Expired' : 'No active plan')}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 10 }}>{renews ? `Renews / ends ${renews}` : 'Subscribe to unlock deployment'}</div>
          </div>

          {/* Deploy access */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Deploy access</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: status.deploy.allowed ? '#4ade80' : '#fca5a5' }}>
              {status.deploy.allowed ? 'Enabled' : 'Locked'}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, lineHeight: 1.6 }}>
              {status.deploy.allowed ? 'Your active plan includes deployment.' : 'You can keep building — deployment needs an active deploy-capable plan.'}
            </div>
          </div>
        </div>
      )}

      {/* ── Currency + payment method ── */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Currency</div>
          <select value={currency} onChange={e => setCurrency(e.target.value)}
            style={{ background: 'rgba(0,0,0,0.3)', color: '#f8fafc', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '10px 14px', fontSize: 13, minWidth: 160 }}>
            {Object.values(CURRENCIES).map(c => <option key={c.code} value={c.code}>{c.symbol} {c.code}</option>)}
          </select>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>Prices shown at a configured rate (not live FX).</div>
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Payment method</div>
          <div style={{ display: 'flex', gap: 12 }}>
            {([
              { id: 'paystack', label: '🌍 Paystack', sub: 'Card, MTN MoMo, M-Pesa, bank' },
              { id: 'stripe', label: '💳 Stripe', sub: 'Global cards' },
            ] as const).map(p => (
              <button key={p.id} onClick={() => setProvider(p.id)} style={{
                flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid',
                borderColor: provider === p.id ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.08)',
                background: provider === p.id ? 'rgba(139,92,246,0.1)' : 'rgba(255,255,255,0.02)', cursor: 'pointer', textAlign: 'left',
              }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: provider === p.id ? '#a78bfa' : '#94a3b8' }}>{p.label}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{p.sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Plan cards (Starter · Growth · Pro · Business) ── */}
      <div style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc', marginBottom: 18 }}>Choose a plan</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 16, marginBottom: 32 }}>
        {PLANS_LIST.map(plan => {
          const isCurrent = plan.id === planId && subActive;
          return (
            <div key={plan.id} style={{
              background: plan.highlighted ? 'linear-gradient(160deg,rgba(139,92,246,0.13),rgba(99,102,241,0.08))' : 'rgba(15,15,25,0.6)',
              border: `1px solid ${isCurrent ? 'rgba(34,197,94,0.4)' : plan.highlighted ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16, padding: 22, position: 'relative',
            }}>
              {isCurrent && <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: '#16a34a', color: '#fff', padding: '3px 12px', borderRadius: 100, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>Current</div>}
              {plan.badge && !isCurrent && <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '3px 12px', borderRadius: 100, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{plan.badge}</div>}
              <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>{plan.name}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 14 }}>
                <span style={{ fontSize: 22, fontWeight: 800 }}>{plan.price === 0 ? 'Free' : fmt(plan.price)}</span>
                {plan.price > 0 && <span style={{ fontSize: 12, color: '#64748b' }}>/mo</span>}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {plan.features.slice(0, 3).map(f => <div key={f} style={{ display: 'flex', gap: 6 }}><span style={{ color: '#8b5cf6' }}>✓</span><span style={{ color: '#94a3b8' }}>{f}</span></div>)}
              </div>
              <button disabled={isCurrent || !!checkoutLoading} onClick={() => !isCurrent && plan.id !== 'free' && handleSubscribe(plan.id)}
                style={{
                  width: '100%', padding: '9px', borderRadius: 8, border: 'none',
                  cursor: isCurrent || plan.id === 'free' ? 'default' : checkoutLoading ? 'wait' : 'pointer',
                  background: isCurrent ? 'rgba(34,197,94,0.1)' : plan.highlighted ? 'linear-gradient(135deg,#8b5cf6,#6366f1)' : 'rgba(255,255,255,0.06)',
                  color: isCurrent ? '#4ade80' : '#fff', fontSize: 13, fontWeight: 600, opacity: checkoutLoading && checkoutLoading !== plan.id ? 0.5 : 1,
                }}>
                {isCurrent ? 'Current plan' : checkoutLoading === plan.id ? 'Redirecting…' : plan.price === 0 ? 'Free' : `Subscribe — ${fmt(plan.price)}`}
              </button>
            </div>
          );
        })}
      </div>

      {/* Setup note — TEST MODE */}
      <div style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.12)', borderRadius: 12, padding: '18px 22px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa', marginBottom: 8 }}>Test mode — add Paystack TEST keys (server env, never in git)</div>
        <pre style={{ marginTop: 10, fontSize: 12, color: '#94a3b8', background: 'rgba(0,0,0,0.3)', padding: '12px 16px', borderRadius: 8, overflow: 'auto', lineHeight: 1.7 }}>
{`PAYSTACK_SECRET_KEY=sk_test_...
BILLING_TABLE=<DynamoDB table name>
DOMAIN_SANDBOX=1
ADMIN_EMAILS=you@example.com`}
        </pre>
      </div>
    </div>
  );
}

export default function BillingPage() {
  return <Suspense><BillingContent /></Suspense>;
}
