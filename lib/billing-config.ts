/**
 * ════════════════════════════════════════════════════════════════════════════
 * DWOMOH Vibe Code — SINGLE SOURCE OF TRUTH FOR ALL BILLING
 * ════════════════════════════════════════════════════════════════════════════
 * Edit pricing, credits, currency, and domain markup HERE. Nothing else needs to
 * change. No secrets live in this file — only prices and rules.
 */

export type PlanId = 'free' | 'starter' | 'growth' | 'pro' | 'business';

export interface PlanLimits {
  /** Monthly credit grant included with the plan (1 credit = $1 of value). */
  monthlyCredits: number;
  canSaveProjects: boolean;
  canExportCode: boolean;
  /** Deployment is gated on an ACTIVE subscription AND this flag. */
  canDeployApps: boolean;
  canCustomDomain: boolean;
  canRemoveBranding: boolean;
  canTeamCollaborate: boolean;
  priorityGeneration: boolean;
}

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  /** USD price per month. Highest paid plan is capped at $35. */
  priceUsd: number;
  /** Paystack plan code (recurring). Non-secret; from env. */
  paystackPlanCodeEnv: string | null;
  features: string[];
  limits: PlanLimits;
  badge?: string;
  highlighted?: boolean;
}

// ── PLANS (Starter → Growth → Pro → Business, top = $35) ─────────────────────
export const PLANS: Record<PlanId, SubscriptionPlan> = {
  free: {
    id: 'free', name: 'Free', priceUsd: 0, paystackPlanCodeEnv: null,
    features: ['5 starter credits', 'Live preview', 'Community support', 'DWOMOH branding'],
    limits: { monthlyCredits: 5, canSaveProjects: false, canExportCode: false, canDeployApps: false, canCustomDomain: false, canRemoveBranding: false, canTeamCollaborate: false, priorityGeneration: false },
  },
  starter: {
    id: 'starter', name: 'Starter', priceUsd: 9,
    paystackPlanCodeEnv: process.env.PAYSTACK_STARTER_PLAN ?? null,
    features: ['$9 credits / month', 'Save & manage projects', 'Export source code', 'Email support'],
    limits: { monthlyCredits: 9, canSaveProjects: true, canExportCode: true, canDeployApps: false, canCustomDomain: false, canRemoveBranding: false, canTeamCollaborate: false, priorityGeneration: false },
  },
  growth: {
    id: 'growth', name: 'Growth', priceUsd: 19,
    paystackPlanCodeEnv: process.env.PAYSTACK_GROWTH_PLAN ?? null,
    features: ['$19 credits / month', 'One-click deployment', 'Email support', 'Save & export'],
    limits: { monthlyCredits: 19, canSaveProjects: true, canExportCode: true, canDeployApps: true, canCustomDomain: false, canRemoveBranding: false, canTeamCollaborate: false, priorityGeneration: false },
  },
  pro: {
    id: 'pro', name: 'Pro', priceUsd: 29, badge: 'Most Popular', highlighted: true,
    paystackPlanCodeEnv: process.env.PAYSTACK_PRO_PLAN ?? null,
    features: ['$29 credits / month', 'Deploy + custom domains', 'Remove DWOMOH branding', 'Priority support'],
    limits: { monthlyCredits: 29, canSaveProjects: true, canExportCode: true, canDeployApps: true, canCustomDomain: true, canRemoveBranding: true, canTeamCollaborate: false, priorityGeneration: false },
  },
  business: {
    id: 'business', name: 'Business', priceUsd: 35,
    paystackPlanCodeEnv: process.env.PAYSTACK_BUSINESS_PLAN ?? null,
    features: ['$35 credits / month', 'Team collaboration', 'Priority generation queue', 'Dedicated support'],
    limits: { monthlyCredits: 35, canSaveProjects: true, canExportCode: true, canDeployApps: true, canCustomDomain: true, canRemoveBranding: true, canTeamCollaborate: true, priorityGeneration: true },
  },
};

export const PLANS_LIST = Object.values(PLANS);
export function getPlan(planId: PlanId): SubscriptionPlan { return PLANS[planId] ?? PLANS.free; }

// ── CREDIT WALLET RULES ───────────────────────────────────────────────────────
export const CREDIT_CONFIG = {
  /** 1 USD of verified payment = this many credits. $10 paid → 10 credits. */
  creditsPerUsd: 1,
  /** Credits deducted per successful AI generation. */
  generationCostCredits: 1,
  /** Minimum top-up amount in USD. */
  minTopUpUsd: 5,
};

// ── CURRENCY ──────────────────────────────────────────────────────────────────
// Static, clearly-flagged. We do NOT fake live FX. Each entry is a price the
// admin sets per currency; `isStaticRate` makes it explicit these are configured,
// not live-converted. Paystack must have the currency enabled on your account.
export interface CurrencyConfig {
  code: string;          // ISO 4217, e.g. GHS
  symbol: string;
  paystackSupported: boolean;
  /** Configured (NOT live-converted) multiplier applied to the USD price. */
  usdToLocalStatic: number;
  isStaticRate: true;    // always true — a truthful marker that this is not live FX
}

export const CURRENCIES: Record<string, CurrencyConfig> = {
  USD: { code: 'USD', symbol: '$',   paystackSupported: true,  usdToLocalStatic: 1,    isStaticRate: true },
  GHS: { code: 'GHS', symbol: 'GH₵', paystackSupported: true,  usdToLocalStatic: 15.5, isStaticRate: true },
  NGN: { code: 'NGN', symbol: '₦',   paystackSupported: true,  usdToLocalStatic: 1600, isStaticRate: true },
  ZAR: { code: 'ZAR', symbol: 'R',   paystackSupported: true,  usdToLocalStatic: 18.5, isStaticRate: true },
  KES: { code: 'KES', symbol: 'KSh', paystackSupported: true,  usdToLocalStatic: 129,  isStaticRate: true },
};

/** ISO country code → currency code. Unknown countries fall back to USD. */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  GH: 'GHS', NG: 'NGN', ZA: 'ZAR', KE: 'KES', US: 'USD', GB: 'USD',
};

export const DEFAULT_CURRENCY = 'USD';

export function currencyForCountry(countryCode?: string): CurrencyConfig {
  const cur = countryCode ? COUNTRY_TO_CURRENCY[countryCode.toUpperCase()] : undefined;
  return CURRENCIES[cur ?? DEFAULT_CURRENCY] ?? CURRENCIES.USD;
}

/** Convert a USD price to a displayed local amount using the configured static rate. */
export function priceInCurrency(usd: number, currencyCode: string): { amount: number; display: string; isStaticRate: boolean } {
  const c = CURRENCIES[currencyCode] ?? CURRENCIES.USD;
  const amount = Math.round(usd * c.usdToLocalStatic * 100) / 100;
  return { amount, display: `${c.symbol}${amount.toLocaleString()}`, isStaticRate: c.isStaticRate };
}

// ── DOMAIN BILLING ──────────────────────────────────────────────────────────
export const DOMAIN_CONFIG = {
  /** Selling price = AWS cost × markupMultiplier, then + flatMarkupUsd. Example: $10 → $20. */
  markupMultiplier: 2.0,
  flatMarkupUsd: 0,
  /** Sandbox: never calls AWS RegisterDomainCommand; simulates a successful order. */
  sandboxMode: process.env.DOMAIN_SANDBOX === '1' || process.env.NODE_ENV !== 'production',
};

export function domainSellingPrice(awsCostUsd: number): number {
  return Math.round((awsCostUsd * DOMAIN_CONFIG.markupMultiplier + DOMAIN_CONFIG.flatMarkupUsd) * 100) / 100;
}

export function domainProfit(awsCostUsd: number): number {
  return Math.round((domainSellingPrice(awsCostUsd) - awsCostUsd) * 100) / 100;
}
