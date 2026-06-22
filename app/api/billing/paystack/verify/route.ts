/**
 * GET /api/billing/paystack/verify?reference=xxx
 * Paystack redirects here after payment with ?reference=
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const reference = req.nextUrl.searchParams.get('reference');
  if (!reference) {
    return NextResponse.redirect(new URL('/dashboard/billing?error=missing_reference', req.url));
  }

  try {
    const { verifyPaystackTransaction } = await import('@/services/billing');
    const result = await verifyPaystackTransaction(reference);

    if (result.success) {
      return NextResponse.redirect(
        new URL(`/dashboard/billing?success=1&plan=${result.planId ?? ''}`, req.url)
      );
    } else {
      return NextResponse.redirect(new URL('/dashboard/billing?error=payment_failed', req.url));
    }
  } catch (e) {
    return NextResponse.redirect(new URL(`/dashboard/billing?error=${encodeURIComponent((e as Error).message)}`, req.url));
  }
}
