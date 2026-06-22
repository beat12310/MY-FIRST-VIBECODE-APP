/**
 * Subscription & credit management service.
 * Architecture is Stripe + Paystack ready.
 * Local dev uses a JSON file in /tmp as the credit store.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { PlanId } from '@/lib/subscription-plans';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserSubscription {
  userId: string;
  email: string;
  planId: PlanId;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  paystackCustomerCode: string | null;
  paystackSubscriptionCode: string | null;
  generationsUsedThisMonth: number;
  billingCycleStart: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreditEvent {
  userId: string;
  type: 'generation' | 'reset' | 'plan_change' | 'manual_grant';
  amount: number;
  projectName?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Local store (development / before DynamoDB is connected) ──────────────────

const STORE_DIR = '/tmp/dwomoh-vibecode-subscriptions';
const EVENTS_DIR = '/tmp/dwomoh-vibecode-events';

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

function subPath(userId: string) {
  return join(STORE_DIR, `${userId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

async function readSub(userId: string): Promise<UserSubscription | null> {
  try {
    const raw = await readFile(subPath(userId), 'utf-8');
    return JSON.parse(raw) as UserSubscription;
  } catch {
    return null;
  }
}

async function writeSub(sub: UserSubscription): Promise<void> {
  await ensureDir(STORE_DIR);
  await writeFile(subPath(sub.userId), JSON.stringify(sub, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOrCreateSubscription(userId: string, email: string): Promise<UserSubscription> {
  let sub = await readSub(userId);
  if (sub) return sub;

  const now = new Date().toISOString();
  sub = {
    userId,
    email,
    planId: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    paystackCustomerCode: null,
    paystackSubscriptionCode: null,
    generationsUsedThisMonth: 0,
    billingCycleStart: now,
    createdAt: now,
    updatedAt: now,
  };
  await writeSub(sub);
  return sub;
}

export async function getSubscription(userId: string): Promise<UserSubscription | null> {
  return readSub(userId);
}

export async function recordGeneration(userId: string, projectName: string): Promise<{ allowed: boolean; remaining: number; used: number }> {
  const sub = await readSub(userId);
  if (!sub) return { allowed: false, remaining: 0, used: 0 };

  const { PLANS } = await import('@/lib/subscription-plans');
  const plan = PLANS[sub.planId];
  const limit = plan.limits.generationsPerMonth;

  // Check if billing cycle has rolled over
  const cycleStart = new Date(sub.billingCycleStart);
  const now = new Date();
  const daysSinceCycle = (now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCycle >= 30) {
    sub.generationsUsedThisMonth = 0;
    sub.billingCycleStart = now.toISOString();
  }

  if (sub.generationsUsedThisMonth >= limit) {
    return { allowed: false, remaining: 0, used: sub.generationsUsedThisMonth };
  }

  sub.generationsUsedThisMonth += 1;
  sub.updatedAt = now.toISOString();
  await writeSub(sub);

  await logCreditEvent({
    userId,
    type: 'generation',
    amount: -1,
    projectName,
    timestamp: now.toISOString(),
  });

  return {
    allowed: true,
    remaining: limit - sub.generationsUsedThisMonth,
    used: sub.generationsUsedThisMonth,
  };
}

export async function upgradePlan(userId: string, newPlanId: PlanId): Promise<UserSubscription> {
  let sub = await readSub(userId);
  if (!sub) throw new Error('Subscription not found');

  sub = {
    ...sub,
    planId: newPlanId,
    updatedAt: new Date().toISOString(),
  };
  await writeSub(sub);

  await logCreditEvent({
    userId,
    type: 'plan_change',
    amount: 0,
    timestamp: new Date().toISOString(),
    metadata: { newPlanId },
  });

  return sub;
}

export async function updateStripeIds(userId: string, updates: {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}): Promise<void> {
  const sub = await readSub(userId);
  if (!sub) return;
  Object.assign(sub, updates, { updatedAt: new Date().toISOString() });
  await writeSub(sub);
}

export async function updatePaystackIds(userId: string, updates: {
  paystackCustomerCode?: string;
  paystackSubscriptionCode?: string;
}): Promise<void> {
  const sub = await readSub(userId);
  if (!sub) return;
  Object.assign(sub, updates, { updatedAt: new Date().toISOString() });
  await writeSub(sub);
}

async function logCreditEvent(event: CreditEvent): Promise<void> {
  await ensureDir(EVENTS_DIR);
  const file = join(EVENTS_DIR, `${event.userId.replace(/[^a-z0-9_-]/gi, '_')}-events.jsonl`);
  const line = JSON.stringify(event) + '\n';
  try {
    const existing = await readFile(file, 'utf-8').catch(() => '');
    await writeFile(file, existing + line, 'utf-8');
  } catch {
    /* non-critical */
  }
}
