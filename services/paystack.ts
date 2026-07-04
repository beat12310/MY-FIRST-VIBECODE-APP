/**
 * Paystack server helper. Secret key never leaves the server. Webhooks are
 * verified with HMAC-SHA512 over the RAW body using PAYSTACK_SECRET_KEY (this is
 * how Paystack signs — there is no separate "webhook secret").
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { CURRENCIES, priceInCurrency } from '@/lib/billing-config';

function secret(): string {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k) throw new Error('PAYSTACK_SECRET_KEY not set');
  return k;
}

/** Verify the x-paystack-signature header against the raw request body. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return false;
  const expected = createHmac('sha512', key).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InitResult { authorizationUrl: string; reference: string; accessCode: string; }

/**
 * Initialize a one-off charge (top-up or domain). amountUsd is the value we
 * credit/charge; the customer is billed in `currency` using the configured
 * static rate. metadata MUST include userId + purpose so the webhook can act.
 */
export async function initCharge(opts: {
  email: string; amountUsd: number; currency: string; reference: string;
  callbackUrl: string; metadata: Record<string, unknown>;
}): Promise<InitResult> {
  const cur = CURRENCIES[opts.currency] ?? CURRENCIES.USD;
  const local = priceInCurrency(opts.amountUsd, cur.code).amount;
  const subunits = Math.round(local * 100); // kobo/pesewas/cents

  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: opts.email,
      amount: subunits,
      currency: cur.code,
      reference: opts.reference,
      callback_url: opts.callbackUrl,
      metadata: { ...opts.metadata, amountUsd: opts.amountUsd, currency: cur.code },
      channels: ['card', 'bank', 'ussd', 'mobile_money'],
    }),
  });
  const data = await res.json() as { status: boolean; message?: string; data?: { authorization_url: string; access_code: string; reference: string } };
  if (!data.status || !data.data) throw new Error(`Paystack init failed: ${data.message ?? 'unknown'}`);
  return { authorizationUrl: data.data.authorization_url, reference: data.data.reference, accessCode: data.data.access_code };
}

/** Server-side verify a transaction by reference. */
export async function verifyTransaction(reference: string): Promise<{ success: boolean; metadata?: Record<string, unknown>; amountUsd?: number }> {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret()}` },
  });
  const data = await res.json() as { status: boolean; data?: { status: string; metadata?: Record<string, unknown> } };
  if (!data.status || data.data?.status !== 'success') return { success: false };
  const md = data.data.metadata ?? {};
  return { success: true, metadata: md, amountUsd: typeof md.amountUsd === 'number' ? md.amountUsd : undefined };
}

export function newReference(prefix: string, userId: string): string {
  return `${prefix}-${userId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
