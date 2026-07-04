/**
 * Billing service — Stripe + Paystack ready architecture.
 * Replace stubs with live SDK calls once price IDs and webhook secrets
 * are added to .env.local.
 */

import type { PlanId } from '@/lib/subscription-plans';

// ── Stripe ────────────────────────────────────────────────────────────────────

export interface StripeCheckoutSession {
  sessionId: string;
  url: string;
}

export interface StripePriceMap {
  starter: string | null;
  growth: string | null;
  pro: string | null;
  business: string | null;
}

function getStripePrices(): StripePriceMap {
  return {
    starter:  process.env.STRIPE_STARTER_PRICE_ID  ?? null,
    growth:   process.env.STRIPE_GROWTH_PRICE_ID    ?? null,
    pro:      process.env.STRIPE_PRO_PRICE_ID       ?? null,
    business: process.env.STRIPE_BUSINESS_PRICE_ID  ?? null,
  };
}

/**
 * Create a Stripe Checkout session for a subscription upgrade.
 * Returns the hosted Stripe URL the user should be redirected to.
 *
 * To activate: npm install stripe  and add STRIPE_SECRET_KEY to .env.local
 */
export async function createStripeCheckoutSession(opts: {
  userId: string;
  email: string;
  planId: Exclude<PlanId, 'free'>;
  successUrl: string;
  cancelUrl: string;
  stripeCustomerId?: string | null;
}): Promise<StripeCheckoutSession> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new Error('STRIPE_SECRET_KEY not set. Add it to .env.local to enable payments.');
  }

  const prices = getStripePrices();
  const priceId = prices[opts.planId];
  if (!priceId) {
    throw new Error(`STRIPE_${opts.planId.toUpperCase()}_PRICE_ID not set in .env.local`);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Stripe = eval('require')('stripe');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stripe = new (Stripe as any)(stripeKey, { apiVersion: '2024-06-20' });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer: opts.stripeCustomerId ?? undefined,
    customer_email: opts.stripeCustomerId ? undefined : opts.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: opts.cancelUrl,
    metadata: { userId: opts.userId, planId: opts.planId },
    subscription_data: { metadata: { userId: opts.userId } },
  });

  return { sessionId: session.id, url: session.url! };
}

/**
 * Handle a Stripe webhook event.
 * Mount at POST /api/billing/stripe/webhook
 * Add STRIPE_WEBHOOK_SECRET to .env.local (from `stripe listen` or dashboard).
 */
export async function handleStripeWebhook(rawBody: string, signature: string): Promise<{ handled: boolean; event: string }> {
  const stripeKey    = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) throw new Error('Stripe env vars not set');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Stripe = eval('require')('stripe');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stripe = new (Stripe as any)(stripeKey, { apiVersion: '2024-06-20' });
  const event  = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

  const { updateStripeIds, upgradePlan } = await import('./subscription');

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as { metadata?: Record<string, string>; customer?: string; subscription?: string };
      const userId = session.metadata?.userId;
      const planId = session.metadata?.planId as PlanId | undefined;
      if (userId && planId) {
        await updateStripeIds(userId, {
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
        });
        await upgradePlan(userId, planId);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as { metadata?: Record<string, string> };
      const userId = sub.metadata?.userId;
      if (userId) await upgradePlan(userId, 'free');
      break;
    }
  }

  return { handled: true, event: event.type };
}

// ── Paystack ──────────────────────────────────────────────────────────────────

export interface PaystackCheckoutResult {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
}

/**
 * Initialize a Paystack subscription payment.
 * To activate: add PAYSTACK_SECRET_KEY to .env.local
 * Paystack supports cards, bank transfer, MTN MoMo, M-Pesa, Airtel Money.
 */
export async function createPaystackCheckout(opts: {
  userId: string;
  email: string;
  planId: Exclude<PlanId, 'free'>;
  callbackUrl: string;
}): Promise<PaystackCheckoutResult> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY not set in .env.local');

  const planCodes: Record<string, string | undefined> = {
    starter:  process.env.PAYSTACK_STARTER_PLAN,
    pro:      process.env.PAYSTACK_PRO_PLAN,
    business: process.env.PAYSTACK_BUSINESS_PLAN,
  };
  const planCode = planCodes[opts.planId];
  if (!planCode) throw new Error(`PAYSTACK_${opts.planId.toUpperCase()}_PLAN not set`);

  const reference = `dwomoh-${opts.userId.slice(0, 8)}-${Date.now()}`;

  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        opts.email,
      plan:         planCode,
      reference,
      callback_url: opts.callbackUrl,
      metadata:     { userId: opts.userId, planId: opts.planId },
      channels:     ['card', 'bank', 'ussd', 'mobile_money'],
    }),
  });

  const data = (await res.json()) as { status: boolean; data?: { authorization_url: string; access_code: string; reference: string } };
  if (!data.status || !data.data) throw new Error('Paystack initialization failed');

  return {
    reference: data.data.reference,
    authorizationUrl: data.data.authorization_url,
    accessCode: data.data.access_code,
  };
}

/**
 * Verify a Paystack transaction and upgrade the user's plan.
 * Call this from the Paystack callback route after redirect.
 */
export async function verifyPaystackTransaction(reference: string): Promise<{ success: boolean; planId?: PlanId; userId?: string }> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY not set');

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  const data = (await res.json()) as {
    status: boolean;
    data?: {
      status: string;
      metadata?: { userId?: string; planId?: string };
      customer?: { code: string };
      subscription?: { subscription_code: string };
    };
  };

  if (!data.status || data.data?.status !== 'success') return { success: false };

  const userId = data.data?.metadata?.userId;
  const planId = data.data?.metadata?.planId as PlanId | undefined;

  if (userId && planId) {
    const { upgradePlan, updatePaystackIds } = await import('./subscription');
    await upgradePlan(userId, planId);
    await updatePaystackIds(userId, {
      paystackCustomerCode:     data.data?.customer?.code,
      paystackSubscriptionCode: data.data?.subscription?.subscription_code,
    });
  }

  return { success: true, planId, userId };
}
