/**
 * Credit wallet. 1 credit = $1 of value (CREDIT_CONFIG.creditsPerUsd).
 * Credits only ever increase via a VERIFIED Paystack payment (processPayment),
 * and decrease when an AI generation succeeds (deduct). Every movement is logged
 * to the ledger. Top-up is allowed anytime, independent of subscription state.
 */
import { CREDIT_CONFIG } from '@/lib/billing-config';
import { getItem, putItem, queryItems } from './billing-store';

export interface Wallet { pk: string; sk: 'WALLET'; userId: string; credits: number; updatedAt: string; [k: string]: unknown; }
export interface LedgerEntry { pk: string; sk: string; userId: string; delta: number; balanceAfter: number; reason: string; ref?: string; at: string; [k: string]: unknown; }
export interface PaymentRecord { pk: string; sk: string; userId: string; reference: string; amountUsd: number; purpose: 'topup' | 'subscription' | 'domain'; status: 'processed'; processedAt: string; meta?: Record<string, unknown>; [k: string]: unknown; }

const userPk = (u: string) => `USER#${u}`;

export async function getBalance(userId: string): Promise<number> {
  const w = await getItem(userPk(userId), 'WALLET') as Wallet | null;
  return w?.credits ?? 0;
}

async function setBalance(userId: string, credits: number): Promise<void> {
  await putItem({ pk: userPk(userId), sk: 'WALLET', userId, credits, updatedAt: new Date().toISOString() } as Wallet);
}

async function appendLedger(userId: string, delta: number, balanceAfter: number, reason: string, ref?: string): Promise<void> {
  const at = new Date().toISOString();
  const sk = `LEDGER#${at}#${Math.random().toString(36).slice(2, 8)}`;
  await putItem({ pk: userPk(userId), sk, userId, delta, balanceAfter, reason, ref, at } as LedgerEntry);
}

/**
 * Apply a VERIFIED payment exactly once (idempotent by reference). Called only
 * from the Paystack webhook / server-side verify — never from the frontend.
 */
export async function processPayment(opts: {
  userId: string; reference: string; amountUsd: number; purpose: PaymentRecord['purpose']; meta?: Record<string, unknown>;
}): Promise<{ applied: boolean; creditsAdded: number; balance: number }> {
  const payKey = `PAYMENT#${opts.reference}`;
  const existing = await getItem(userPk(opts.userId), payKey);
  if (existing) {
    return { applied: false, creditsAdded: 0, balance: await getBalance(opts.userId) }; // already processed
  }

  // Record the payment first so a duplicate webhook can't double-credit.
  const rec: PaymentRecord = {
    pk: userPk(opts.userId), sk: payKey, userId: opts.userId, reference: opts.reference,
    amountUsd: opts.amountUsd, purpose: opts.purpose, status: 'processed', processedAt: new Date().toISOString(), meta: opts.meta,
  };
  await putItem(rec);
  await putItem({ pk: `PAYREF#${opts.reference}`, sk: 'PAYMENT', userId: opts.userId, reference: opts.reference }); // reverse lookup

  let creditsAdded = 0;
  if (opts.purpose === 'topup' || opts.purpose === 'subscription') {
    creditsAdded = Math.round(opts.amountUsd * CREDIT_CONFIG.creditsPerUsd * 100) / 100;
    const bal = (await getBalance(opts.userId)) + creditsAdded;
    await setBalance(opts.userId, bal);
    await appendLedger(opts.userId, creditsAdded, bal, `${opts.purpose} payment`, opts.reference);
    return { applied: true, creditsAdded, balance: bal };
  }
  // domain payments don't add credits; they unlock the domain order (handled elsewhere)
  return { applied: true, creditsAdded: 0, balance: await getBalance(opts.userId) };
}

/** Deduct credits for a successful generation. Returns allowed=false if insufficient. */
export async function deduct(userId: string, reason = 'generation', cost = CREDIT_CONFIG.generationCostCredits): Promise<{ allowed: boolean; balance: number }> {
  const bal = await getBalance(userId);
  if (bal < cost) return { allowed: false, balance: bal };
  const next = Math.round((bal - cost) * 100) / 100;
  await setBalance(userId, next);
  await appendLedger(userId, -cost, next, reason);
  return { allowed: true, balance: next };
}

/** Monthly plan credit grant (called on subscription activation/renewal). */
export async function grantMonthlyCredits(userId: string, credits: number, ref: string): Promise<number> {
  const bal = (await getBalance(userId)) + credits;
  await setBalance(userId, bal);
  await appendLedger(userId, credits, bal, 'monthly plan credits', ref);
  return bal;
}

/** Grant a one-time initial credit allowance (free plan) the first time we see a user. Idempotent. */
export async function ensureInitialGrant(userId: string, credits: number): Promise<void> {
  const marker = await getItem(userPk(userId), 'INIT_GRANT');
  if (marker) return;
  await putItem({ pk: userPk(userId), sk: 'INIT_GRANT', userId, grantedAt: new Date().toISOString() });
  if (credits > 0) {
    const bal = (await getBalance(userId)) + credits;
    await setBalance(userId, bal);
    await appendLedger(userId, credits, bal, 'initial free credits');
  }
}

export async function getLedger(userId: string): Promise<LedgerEntry[]> {
  const rows = await queryItems(userPk(userId), 'LEDGER#') as LedgerEntry[];
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}
