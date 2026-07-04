/**
 * Backward-compatibility shim. The single source of truth is now `lib/billing-config.ts`.
 * This file preserves the older export shape (price/priceMonthly/generationsPerMonth)
 * so existing imports keep working while billing migrates to the credit model.
 */
import {
  PLANS as CONFIG_PLANS,
  type PlanId as ConfigPlanId,
  type SubscriptionPlan as ConfigPlan,
  getPlan as configGetPlan,
} from './billing-config';

export type PlanId = ConfigPlanId;

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  price: number;
  priceMonthly: string;
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

function toLegacy(p: ConfigPlan): SubscriptionPlan {
  return {
    id: p.id,
    name: p.name,
    price: p.priceUsd,
    priceMonthly: `$${p.priceUsd}`,
    paystackPlanCode: p.paystackPlanCodeEnv,
    generationsPerMonth: p.limits.monthlyCredits, // credits are the new unit
    features: p.features,
    limits: {
      generationsPerMonth: p.limits.monthlyCredits,
      canSaveProjects: p.limits.canSaveProjects,
      canExportCode: p.limits.canExportCode,
      canDeployApps: p.limits.canDeployApps,
      canCustomDomain: p.limits.canCustomDomain,
      canRemoveBranding: p.limits.canRemoveBranding,
      canTeamCollaborate: p.limits.canTeamCollaborate,
      priorityGeneration: p.limits.priorityGeneration,
    },
    badge: p.badge,
    highlighted: p.highlighted,
  };
}

export const PLANS: Record<PlanId, SubscriptionPlan> = Object.fromEntries(
  Object.entries(CONFIG_PLANS).map(([k, v]) => [k, toLegacy(v)]),
) as Record<PlanId, SubscriptionPlan>;

export const PLANS_LIST = Object.values(PLANS);
export function getPlan(planId: PlanId): SubscriptionPlan { return toLegacy(configGetPlan(planId)); }
export function canGenerate(planId: PlanId, used: number): boolean { return used < getPlan(planId).limits.generationsPerMonth; }
export function generationsRemaining(planId: PlanId, used: number): number { return Math.max(0, getPlan(planId).limits.generationsPerMonth - used); }
