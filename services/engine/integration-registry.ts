/**
 * Integration Registry — the engine's catalog of every automatic wiring
 * guarantee a generated feature receives, independent of application domain.
 *
 * Why this exists: every previous phase hand-wired one integration point at
 * a time (middleware protection, orphaned-API detection, project memory)
 * directly inside verifier.ts/repairer.ts/builder.ts. That worked, but each
 * new integration meant touching three files with bespoke glue. This module
 * makes "integration" a first-class, pluggable concept: a rule declares WHEN
 * it applies, HOW to detect a gap, and HOW to close it — and the verifier/
 * repairer loop over the registry generically instead of hand-coding each
 * check. Adding a new integration type going forward means writing one
 * IntegrationRule and calling registerIntegration() — no changes to the
 * generation pipeline itself.
 *
 * CORE vs OPTIONAL:
 *   - core: must hold for every generated app regardless of domain
 *     (navigation, routing, middleware, auth, API registration, project
 *     memory, dependency graph). appliesTo() is always true for these.
 *   - optional: only relevant when the generated project actually has the
 *     required infrastructure (a dashboard page, a dynamic detail route, a
 *     database). appliesTo() gates these — an app with no dashboard simply
 *     never runs the dashboard-widgets rule, rather than the rule silently
 *     doing nothing every time.
 *
 * Several rules below are honest placeholders (search indexing, role-based
 * permissions, analytics, notifications, migrations): the current generated-
 * app template has no underlying infrastructure for these yet (no search
 * index, no per-route role model, no analytics/notification provider, no
 * migration system beyond SQLite's idempotent CREATE TABLE IF NOT EXISTS).
 * Registering them now — with detect() returning no gaps until their
 * appliesTo() gate can ever be true — means the catalog is complete and
 * future infrastructure can activate them without redesigning this module.
 */

import type { AppPlan } from './types';

export type IntegrationCategory = 'core' | 'optional';

export interface IntegrationContext {
  plan: AppPlan;
  files: { path: string; content: string }[];
  fileSet: Set<string>;
  /** Resolved page routes, e.g. "/courses", "/courses/[id]". */
  routes: string[];
  /** Resolved API route URLs, e.g. "/api/courses", "/api/courses/[id]". */
  apiRoutes: string[];
}

export interface IntegrationGap {
  integrationId: string;
  /** Human-readable; MUST end with the target file path (repairer convention). */
  detail: string;
  targetFile: string;
}

export interface IntegrationApplyResult { changedFiles: string[] }

export interface IntegrationRule {
  id: string;
  label: string;
  category: IntegrationCategory;
  /** Optional -- defaults to always-true (core). Optional rules override this. */
  appliesTo(ctx: IntegrationContext): boolean;
  detect(ctx: IntegrationContext): IntegrationGap[];
  apply(gap: IntegrationGap, projectPath: string, ctx: IntegrationContext): Promise<IntegrationApplyResult | null>;
  /**
   * Explains WHY a rule has no real detect()/apply() yet (structurally
   * guaranteed elsewhere, no underlying infra exists, satisfied by
   * construction) — required on any rule whose detect() always returns [].
   * Keeps the registry self-documenting: reading it tells you the FULL
   * integration surface, not just the currently-active checks.
   */
  note?: string;
}

const registry: IntegrationRule[] = [];

export function registerIntegration(rule: IntegrationRule): void {
  if (registry.some(r => r.id === rule.id)) throw new Error(`Integration "${rule.id}" already registered`);
  registry.push(rule);
}

export function getIntegrationRegistry(): readonly IntegrationRule[] { return registry; }

export function activeIntegrations(ctx: IntegrationContext): IntegrationRule[] {
  return registry.filter(r => r.appliesTo(ctx));
}

/** Runs every applicable rule's detect() and flattens the results. */
export function detectIntegrationGaps(ctx: IntegrationContext): IntegrationGap[] {
  return activeIntegrations(ctx).flatMap(r => r.detect(ctx));
}

/** Looks up the owning rule for a gap produced by detectIntegrationGaps(). */
export function findRule(integrationId: string): IntegrationRule | undefined {
  return registry.find(r => r.id === integrationId);
}
