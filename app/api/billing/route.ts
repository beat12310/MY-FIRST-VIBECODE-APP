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

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
