/**
 * GET /api/admin/revenue — revenue dashboard foundation.
 * Admin-only (email must be in ADMIN_EMAILS, comma-separated). Aggregates the
 * billing store into headline numbers. Read-only; safe to call repeatedly.
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { getAuthUser } = await import('@/lib/server-auth');
  const user = await getAuthUser(req);
  const admins = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!user?.email || !admins.includes(user.email.toLowerCase())) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 });
  }

  const { scanAll } = await import('@/services/billing-store');
  const items = await scanAll();

  const payments = items.filter(i => typeof i.sk === 'string' && i.sk.startsWith('PAYMENT#'));
  const domains  = items.filter(i => typeof i.sk === 'string' && i.sk.startsWith('DOMAIN#'));
  const subs     = items.filter(i => i.sk === 'SUB');

  const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;

  const subscriptionRevenue = sum(payments.filter(p => p.purpose === 'subscription').map(p => Number(p.amountUsd) || 0));
  const creditTopups        = sum(payments.filter(p => p.purpose === 'topup').map(p => Number(p.amountUsd) || 0));
  const domainSalesRevenue  = sum(domains.filter(d => ['paid','registering','registered','registered_sandbox'].includes(String(d.status))).map(d => Number(d.sellingPriceUsd) || 0));
  const awsDomainCost       = sum(domains.filter(d => ['registering','registered','registered_sandbox'].includes(String(d.status))).map(d => Number(d.awsCostUsd) || 0));
  const domainProfitTotal   = sum(domains.filter(d => ['registering','registered','registered_sandbox'].includes(String(d.status))).map(d => Number(d.profitUsd) || 0));

  const grossRevenue = sum([subscriptionRevenue, creditTopups, domainSalesRevenue]);
  // Paystack fees vary by country/method and aren't returned to us here — left null
  // rather than guessed. Net is an ESTIMATE: gross minus known AWS domain cost.
  const netProfitEstimate = sum([grossRevenue - awsDomainCost]);

  return NextResponse.json({
    asOf: new Date().toISOString(),
    counts: { activeSubscriptions: subs.filter(s => s.status === 'active').length, totalUsers: subs.length, domains: domains.length },
    revenue: {
      subscriptionRevenue, creditTopups, domainSalesRevenue,
      grossRevenue,
      awsDomainCost,
      domainProfit: domainProfitTotal,
      paystackFees: null,            // not available from stored data
      netProfitEstimate,
    },
    pendingDomainRegistrations: domains.filter(d => d.status === 'pending_payment' || d.status === 'registering').length,
    failedPayments: null,            // failed charges are not persisted yet (webhook only acts on success)
    note: 'Paystack fees and failed-payment tracking require capturing additional webhook events; numbers above reflect successful, verified payments only.',
  });
}
