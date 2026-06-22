/**
 * POST /api/billing/stripe/webhook
 * Stripe sends signed events here after each billing action.
 * Add to .env.local: STRIPE_WEBHOOK_SECRET (from dashboard or `stripe listen`)
 */
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });

  try {
    const rawBody = await req.text();
    const { handleStripeWebhook } = await import('@/services/billing');
    const result = await handleStripeWebhook(rawBody, sig);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
