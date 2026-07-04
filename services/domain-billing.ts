/**
 * Domain billing with a hard payment gate.
 *
 * FLOW: quote (AWS cost + markup) → create order (pending_payment) → customer pays
 * via Paystack → webhook verifies payment → fulfillDomainPayment registers the
 * domain. AWS RegisterDomainCommand is NEVER called before payment is verified,
 * and NEVER in sandbox mode (so tests don't incur real AWS charges).
 */
import { DOMAIN_CONFIG, domainProfit, domainSellingPrice } from '@/lib/billing-config';
import { getItem, putItem, queryItems, type StoreItem } from './billing-store';
import { initCharge, newReference } from './paystack';

export type DomainStatus = 'pending_payment' | 'paid' | 'registering' | 'registered' | 'registered_sandbox' | 'failed';

export interface DomainOrder extends StoreItem {
  sk: string; userId: string; domain: string; tld: string;
  awsCostUsd: number; sellingPriceUsd: number; profitUsd: number;
  status: DomainStatus; reference: string; operationId?: string;
  sandbox: boolean; createdAt: string; updatedAt: string;
}

const userPk = (u: string) => `USER#${u}`;
const tldOf = (d: string) => d.slice(d.indexOf('.') + 1);

export async function quoteDomain(domain: string): Promise<{ domain: string; tld: string; awsCostUsd: number; sellingPriceUsd: number; profitUsd: number }> {
  const { getTldPrice } = await import('./deployment/domain-registrar');
  const tld = tldOf(domain);
  const price = await getTldPrice(tld).catch(() => ({ registration: undefined }));
  const awsCostUsd = typeof price.registration === 'number' ? price.registration : 12; // safe default if lookup unavailable
  return { domain, tld, awsCostUsd, sellingPriceUsd: domainSellingPrice(awsCostUsd), profitUsd: domainProfit(awsCostUsd) };
}

/** Create a pending order and a Paystack charge for the selling price. No AWS call here. */
export async function createDomainOrder(opts: { userId: string; email: string; domain: string; currency: string; callbackUrl: string; }): Promise<{ reference: string; authorizationUrl: string; quote: Awaited<ReturnType<typeof quoteDomain>> }> {
  const quote = await quoteDomain(opts.domain);
  const reference = newReference('domain', opts.userId);
  const now = new Date().toISOString();
  const order: DomainOrder = {
    pk: userPk(opts.userId), sk: `DOMAIN#${opts.domain}`, userId: opts.userId, domain: opts.domain, tld: quote.tld,
    awsCostUsd: quote.awsCostUsd, sellingPriceUsd: quote.sellingPriceUsd, profitUsd: quote.profitUsd,
    status: 'pending_payment', reference, sandbox: DOMAIN_CONFIG.sandboxMode, createdAt: now, updatedAt: now,
  };
  await putItem(order);

  const charge = await initCharge({
    email: opts.email, amountUsd: quote.sellingPriceUsd, currency: opts.currency, reference,
    callbackUrl: opts.callbackUrl, metadata: { userId: opts.userId, purpose: 'domain', domain: opts.domain },
  });
  return { reference, authorizationUrl: charge.authorizationUrl, quote };
}

export async function getDomainOrder(userId: string, domain: string): Promise<DomainOrder | null> {
  return await getItem(userPk(userId), `DOMAIN#${domain}`) as DomainOrder | null;
}

export async function listDomainOrders(userId: string): Promise<DomainOrder[]> {
  return await queryItems(userPk(userId), 'DOMAIN#') as DomainOrder[];
}

/**
 * Called by the webhook AFTER payment is verified+recorded. Registers the domain.
 * Sandbox mode marks it registered without touching AWS.
 */
export async function fulfillDomainPayment(userId: string, domain: string): Promise<DomainOrder> {
  const order = await getDomainOrder(userId, domain);
  if (!order) throw new Error(`No domain order for ${domain}`);
  if (order.status === 'registered' || order.status === 'registered_sandbox') return order;

  order.status = 'paid';
  order.updatedAt = new Date().toISOString();
  await putItem(order);

  if (order.sandbox) {
    order.status = 'registered_sandbox';
    order.updatedAt = new Date().toISOString();
    await putItem(order);
    return order;
  }

  try {
    const { purchaseDomain } = await import('./deployment/domain-registrar');
    const result = await purchaseDomain(domain, true) as { operationId?: string };
    order.status = 'registering';
    order.operationId = result.operationId;
  } catch {
    order.status = 'failed';
  }
  order.updatedAt = new Date().toISOString();
  await putItem(order);
  return order;
}
