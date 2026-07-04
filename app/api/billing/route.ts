/**
 * POST /api/billing
 * Body: { action, userId, email, planId, successUrl, cancelUrl, provider }
 * Actions: create-checkout-stripe | create-checkout-paystack | verify-paystack
 */
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    action: string;
    userId?: string;
    email?: string;
    planId?: string;
    successUrl?: string;
    cancelUrl?: string;
    callbackUrl?: string;
    reference?: string;
  };

  const { action } = body;

  if (action === 'create-checkout-stripe') {
    const { userId, email, planId, successUrl, cancelUrl } = body;
    if (!userId || !email || !planId || !successUrl || !cancelUrl) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    try {
      const { createStripeCheckoutSession } = await import('@/services/billing');
      const session = await createStripeCheckoutSession({
        userId, email, planId: planId as 'starter' | 'pro' | 'business',
        successUrl, cancelUrl,
      });
      return NextResponse.json({ url: session.url, sessionId: session.sessionId });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (action === 'create-checkout-paystack') {
    const { userId, email, planId, callbackUrl } = body;
    if (!userId || !email || !planId || !callbackUrl) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    try {
      const { createPaystackCheckout } = await import('@/services/billing');
      const result = await createPaystackCheckout({
        userId, email, planId: planId as 'starter' | 'pro' | 'business', callbackUrl,
      });
      return NextResponse.json({ url: result.authorizationUrl, reference: result.reference });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (action === 'verify-paystack') {
    const { reference } = body;
    if (!reference) return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
    try {
      const { verifyPaystackTransaction } = await import('@/services/billing');
      const result = await verifyPaystackTransaction(reference);
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── status: credit balance + subscription + deploy access (for the UI) ────────
  if (action === 'status') {
    const { userId, email } = body;
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    try {
      const { ensureInitialGrant, getBalance } = await import('@/services/credit-wallet');
      const { getOrCreateSubscription, isActive, canDeploy } = await import('@/services/subscription-manager');
      const { getPlan } = await import('@/lib/billing-config');
      const sub = await getOrCreateSubscription(userId, email ?? '');
      await ensureInitialGrant(userId, getPlan('free').limits.monthlyCredits);
      const balance = await getBalance(userId);
      const gate = await canDeploy(userId);
      return NextResponse.json({
        balance,
        subscription: { planId: sub.planId, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, active: isActive(sub) },
        deploy: { allowed: gate.allowed, reason: gate.reason },
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── topup: one-off Paystack charge that adds credits after verified webhook ───
  if (action === 'topup') {
    const { userId, email, amountUsd, currency, callbackUrl } = body as typeof body & { amountUsd?: number; currency?: string };
    if (!userId || !email || !amountUsd || !callbackUrl) return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    try {
      const { CREDIT_CONFIG } = await import('@/lib/billing-config');
      if (amountUsd < CREDIT_CONFIG.minTopUpUsd) return NextResponse.json({ error: `Minimum top-up is $${CREDIT_CONFIG.minTopUpUsd}` }, { status: 400 });
      const { initCharge, newReference } = await import('@/services/paystack');
      const charge = await initCharge({
        email, amountUsd, currency: currency || 'USD', reference: newReference('topup', userId),
        callbackUrl, metadata: { userId, purpose: 'topup' },
      });
      return NextResponse.json({ url: charge.authorizationUrl, reference: charge.reference });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── subscribe: monthly plan charge; webhook activates plan + grants credits ───
  if (action === 'subscribe') {
    const { userId, email, planId, currency, callbackUrl } = body as typeof body & { currency?: string };
    if (!userId || !email || !planId || !callbackUrl) return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    try {
      const { getPlan } = await import('@/lib/billing-config');
      const plan = getPlan(planId as never);
      if (!plan || plan.priceUsd <= 0) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
      const { initCharge, newReference } = await import('@/services/paystack');
      const charge = await initCharge({
        email, amountUsd: plan.priceUsd, currency: currency || 'USD', reference: newReference('sub', userId),
        callbackUrl, metadata: { userId, purpose: 'subscription', planId },
      });
      return NextResponse.json({ url: charge.authorizationUrl, reference: charge.reference });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
