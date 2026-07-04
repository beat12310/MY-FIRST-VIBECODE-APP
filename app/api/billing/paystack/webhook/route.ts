/**
 * POST /api/billing/paystack/webhook
 *
 * The ONLY trusted source for crediting wallets, activating subscriptions, and
 * fulfilling domains. Verifies x-paystack-signature (HMAC-SHA512 over the raw
 * body using PAYSTACK_SECRET_KEY) before doing anything. The frontend callback
 * is cosmetic only — money state changes here.
 *
 * Payload shape is validated with Zod rather than ad-hoc `typeof` checks: the
 * previous version silently defaulted an invalid `purpose` to 'topup' and an
 * invalid `amountUsd` to 0 instead of rejecting the payload — for a route that
 * moves real money, a malformed field should fail loudly, not get quietly
 * coerced into a plausible-looking default.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const PaystackWebhookSchema = z.object({
  event: z.string().optional(),
  data: z.object({
    reference: z.string().optional(),
    status: z.string().optional(),
    metadata: z.object({
      userId: z.string().optional(),
      purpose: z.enum(['topup', 'subscription', 'domain']).optional(),
      amountUsd: z.number().optional(),
      planId: z.string().optional(),
      domain: z.string().optional(),
    }).catchall(z.unknown()).optional(),
  }).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const signature = req.headers.get('x-paystack-signature');

  const { verifyWebhookSignature } = await import('@/services/paystack');
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const parsed = PaystackWebhookSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.error('[paystack-webhook] payload failed schema validation:', parsed.error.message);
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }
  const event = parsed.data;

  // We only act on successful charges. Everything else is acknowledged with 200.
  if (event.event !== 'charge.success' || event.data?.status !== 'success') {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const md = event.data.metadata ?? {};
  const userId = md.userId;
  const purpose = md.purpose ?? 'topup';
  const reference = event.data.reference;
  const amountUsd = md.amountUsd ?? 0;

  if (!userId || !reference) return NextResponse.json({ received: true, ignored: 'missing userId/reference' }, { status: 200 });

  try {
    const { processPayment } = await import('@/services/credit-wallet');
    // Idempotent: records the payment + credits the wallet (topup/subscription) exactly once.
    const result = await processPayment({ userId, reference, amountUsd, purpose, meta: md });

    if (purpose === 'subscription') {
      const planId = md.planId ?? 'starter';
      const { activateFromPayment } = await import('@/services/subscription-manager');
      // activate only the first time we process this reference
      if (result.applied) await activateFromPayment(userId, planId as never, reference);
    }

    if (purpose === 'domain') {
      const domain = md.domain;
      if (domain) {
        const { fulfillDomainPayment } = await import('@/services/domain-billing');
        await fulfillDomainPayment(userId, domain);
      }
    }

    return NextResponse.json({ received: true, applied: result.applied }, { status: 200 });
  } catch (e) {
    // Return 200 so Paystack doesn't hammer retries on our internal error; log for ops.
    console.error('[paystack-webhook] processing error:', e instanceof Error ? e.message : e);
    return NextResponse.json({ received: true, error: 'processing_failed' }, { status: 200 });
  }
}
