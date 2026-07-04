/**
 * Subscription lifecycle + the server-side deploy gate.
 * Persisted durably via billing-store. Deployment requires an ACTIVE subscription
 * whose plan allows deploy. Expired subscribers can still build/develop.
 */
import { getPlan, type PlanId } from '@/lib/billing-config';
import { getItem, putItem } from './billing-store';
import { grantMonthlyCredits } from './credit-wallet';

export interface Subscription {
  pk: string; sk: 'SUB';
  userId: string; email: string;
  planId: PlanId;
  status: 'active' | 'expired' | 'cancelled' | 'none';
  currentPeriodEnd: string | null;   // ISO; deploy allowed only while now < this
  paystackCustomerCode: string | null;
  paystackSubscriptionCode: string | null;
  createdAt: string; updatedAt: string;
  [k: string]: unknown;
}

const userPk = (u: string) => `USER#${u}`;

export async function getOrCreateSubscription(userId: string, email = ''): Promise<Subscription> {
  const existing = await getItem(userPk(userId), 'SUB') as Subscription | null;
  if (existing) return existing;
  const now = new Date().toISOString();
  const sub: Subscription = {
    pk: userPk(userId), sk: 'SUB', userId, email, planId: 'free', status: 'none',
    currentPeriodEnd: null, paystackCustomerCode: null, paystackSubscriptionCode: null,
    createdAt: now, updatedAt: now,
  };
  await putItem(sub);
  return sub;
}

export function isActive(sub: Subscription | null): boolean {
  if (!sub || sub.status !== 'active' || !sub.currentPeriodEnd) return false;
  return Date.now() < new Date(sub.currentPeriodEnd).getTime();
}

/** THE deploy gate — call this server-side in deploy routes. */
export async function canDeploy(userId: string): Promise<{ allowed: boolean; reason?: string; planId: PlanId }> {
  const sub = await getOrCreateSubscription(userId);

  // SUPER_ADMIN (and any future role granted BYPASS_SUBSCRIPTION) skips this
  // gate entirely, permission-checked against the database via
  // services/rbac.ts — subscription requirements remain fully enforced for
  // every other account.
  try {
    const { hasPermission } = await import('./rbac');
    if (await hasPermission(userId, 'BYPASS_SUBSCRIPTION')) {
      return { allowed: true, planId: sub.planId };
    }
  } catch { /* fail-safe: fall through to the normal subscription check */ }

  if (!isActive(sub)) {
    return { allowed: false, planId: sub.planId, reason: 'Your subscription is not active. You can keep building, but deployment requires an active plan — please subscribe or renew.' };
  }
  if (!getPlan(sub.planId).limits.canDeployApps) {
    return { allowed: false, planId: sub.planId, reason: `Your ${getPlan(sub.planId).name} plan does not include deployment. Upgrade to deploy.` };
  }
  return { allowed: true, planId: sub.planId };
}

/** Activate/renew from a verified payment (called by webhook). Grants monthly credits. */
export async function activateFromPayment(userId: string, planId: PlanId, reference: string, periodDays = 30): Promise<Subscription> {
  const sub = await getOrCreateSubscription(userId);
  const now = new Date();
  const end = new Date(now.getTime() + periodDays * 86400_000);
  const updated: Subscription = {
    ...sub, planId, status: 'active', currentPeriodEnd: end.toISOString(), updatedAt: now.toISOString(),
  };
  await putItem(updated);
  const credits = getPlan(planId).limits.monthlyCredits;
  if (credits > 0) await grantMonthlyCredits(userId, credits, reference).catch(() => {});
  return updated;
}

export async function setPaystackIds(userId: string, ids: { customerCode?: string; subscriptionCode?: string }): Promise<void> {
  const sub = await getOrCreateSubscription(userId);
  await putItem({ ...sub, paystackCustomerCode: ids.customerCode ?? sub.paystackCustomerCode, paystackSubscriptionCode: ids.subscriptionCode ?? sub.paystackSubscriptionCode, updatedAt: new Date().toISOString() });
}

export async function markCancelled(userId: string): Promise<void> {
  const sub = await getOrCreateSubscription(userId);
  // Keep access until currentPeriodEnd; just flip status so it won't auto-renew.
  await putItem({ ...sub, status: 'cancelled', updatedAt: new Date().toISOString() });
}

export async function markExpired(userId: string): Promise<void> {
  const sub = await getOrCreateSubscription(userId);
  await putItem({ ...sub, status: 'expired', planId: 'free', currentPeriodEnd: null, updatedAt: new Date().toISOString() });
}
