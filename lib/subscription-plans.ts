export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  price: number;
  priceMonthly: string;
  stripePriceId: string | null;
  paystackPlanCode: string | null;
  generationsPerMonth: number;
  features: string[];
  limits: {
    generationsPerMonth: number;
    canSaveProjects: boolean;
    canExportCode: boolean;
    canDeployApps: boolean;
    canCustomDomain: boolean;
    canRemoveBranding: boolean;
    canTeamCollaborate: boolean;
    priorityGeneration: boolean;
  };
  badge?: string;
  highlighted?: boolean;
}

export const PLANS: Record<PlanId, SubscriptionPlan> = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    priceMonthly: '$0',
    stripePriceId: null,
    paystackPlanCode: null,
    generationsPerMonth: 3,
    features: [
      '3 app generations per month',
      'Live preview',
      'Community support',
      'DWOMOH Vibe Code branding',
    ],
    limits: {
      generationsPerMonth: 3,
      canSaveProjects: false,
      canExportCode: false,
      canDeployApps: false,
      canCustomDomain: false,
      canRemoveBranding: false,
      canTeamCollaborate: false,
      priorityGeneration: false,
    },
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    price: 9,
    priceMonthly: '$9',
    stripePriceId: process.env.NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID ?? null,
    paystackPlanCode: process.env.NEXT_PUBLIC_PAYSTACK_STARTER_PLAN ?? null,
    generationsPerMonth: 20,
    features: [
      '20 app generations per month',
      'Save & manage projects',
      'Export source code',
      'Email support',
    ],
    limits: {
      generationsPerMonth: 20,
      canSaveProjects: true,
      canExportCode: true,
      canDeployApps: false,
      canCustomDomain: false,
      canRemoveBranding: false,
      canTeamCollaborate: false,
      priorityGeneration: false,
    },
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    price: 19,
    priceMonthly: '$19',
    stripePriceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID ?? null,
    paystackPlanCode: process.env.NEXT_PUBLIC_PAYSTACK_PRO_PLAN ?? null,
    generationsPerMonth: 80,
    badge: 'Most Popular',
    highlighted: true,
    features: [
      '80 app generations per month',
      'One-click deployment',
      'Custom domains',
      'Remove DWOMOH branding',
      'Priority support',
    ],
    limits: {
      generationsPerMonth: 80,
      canSaveProjects: true,
      canExportCode: true,
      canDeployApps: true,
      canCustomDomain: true,
      canRemoveBranding: true,
      canTeamCollaborate: false,
      priorityGeneration: false,
    },
  },

  business: {
    id: 'business',
    name: 'Business',
    price: 49,
    priceMonthly: '$49',
    stripePriceId: process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID ?? null,
    paystackPlanCode: process.env.NEXT_PUBLIC_PAYSTACK_BUSINESS_PLAN ?? null,
    generationsPerMonth: 999,
    features: [
      'Unlimited generations',
      'Team collaboration',
      'Priority generation queue',
      'Dedicated support',
      'Advanced analytics',
    ],
    limits: {
      generationsPerMonth: 999,
      canSaveProjects: true,
      canExportCode: true,
      canDeployApps: true,
      canCustomDomain: true,
      canRemoveBranding: true,
      canTeamCollaborate: true,
      priorityGeneration: true,
    },
  },
};

export const PLANS_LIST = Object.values(PLANS);

export function getPlan(planId: PlanId): SubscriptionPlan {
  return PLANS[planId] ?? PLANS.free;
}

export function canGenerate(planId: PlanId, usedThisMonth: number): boolean {
  const plan = getPlan(planId);
  return usedThisMonth < plan.limits.generationsPerMonth;
}

export function generationsRemaining(planId: PlanId, usedThisMonth: number): number {
  const plan = getPlan(planId);
  return Math.max(0, plan.limits.generationsPerMonth - usedThisMonth);
}
