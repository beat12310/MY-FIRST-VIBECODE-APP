/**
 * DWOMOH VIBE CODE — Planner Engine (Step 2).
 *
 * Reads the Step 1 declarative data (types, service-registry, app-types) and turns
 * a user prompt into a structured AppPlan: intent, pages, routes, components, data
 * models, capabilities, and capabilities resolved to provider + version.
 *
 * SCOPE NOTE: this module is NOT wired into /api/chat or any runtime path yet.
 * It imports ONLY the Step 1 data files — nothing from the existing build/auth/
 * billing/deploy code — so creating it changes no existing behavior.
 *
 * Classification here is deterministic (keyword + registry signals). Model-based
 * classification is a later enhancement that can populate the same DetectedIntent
 * shape (source: 'model').
 */
import { SERVICE_REGISTRY } from './service-registry';
import { APP_TYPE_PROFILES } from '@/lib/app-types';
import type {
  AppPlan, AppType, CapabilityId, DetectedIntent, PlannedApiRoute,
  PlannedComponent, PlannedDataModel, PlannedPage, ResolvedCapability, UiStyle,
} from './types';

// ── Small pure helpers ────────────────────────────────────────────────────────
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}
function titleCase(s: string): string {
  return s.replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}
function routeToFilePath(route: string): string {
  if (route === '/') return 'app/page.tsx';
  return `app${route}/page.tsx`;
}
/** Resource segment of a top-level collection route, e.g. "/products" → "products". */
function resourceOf(route: string): string | null {
  const m = route.match(/^\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
}

// ── 1. Intent classification (precedence: memory > model > keyword) ──────────
const META_TYPES = new Set<AppType>(['hybrid', 'multi_domain', 'custom', 'unknown']);

/**
 * Optional higher-precedence inputs for classification. When the engine is fully
 * wired, the orchestrator will populate these; until then they're simply omitted
 * and the deterministic keyword classifier runs. The data model already supports
 * this so no later signature change is needed.
 */
export interface PlannerContext {
  /** Intent recovered from Project Memory (existing project) — HIGHEST precedence. */
  memoryIntent?: DetectedIntent | null;
  /** Intent from an LLM classifier — overrides keyword matching. */
  modelIntent?: DetectedIntent | null;
}

export function classifyIntent(prompt: string, ctx: PlannerContext = {}): DetectedIntent {
  // Project Memory wins (a returning project keeps its established type).
  if (ctx.memoryIntent) return { ...ctx.memoryIntent, source: 'memory' };
  // Model classification beats keywords (handles brand names / unusual phrasing).
  if (ctx.modelIntent) return { ...ctx.modelIntent, source: 'model' };

  const lower = prompt.toLowerCase();

  const scored: { type: AppType; score: number }[] = [];
  for (const type of Object.keys(APP_TYPE_PROFILES) as AppType[]) {
    if (META_TYPES.has(type)) continue;
    const profile = APP_TYPE_PROFILES[type];
    const score = profile.keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
    if (score > 0) scored.push({ type, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { appType: 'unknown', secondaryTypes: [], confidence: 0.2, label: APP_TYPE_PROFILES.unknown.label, source: 'fallback' };
  }

  const primary = scored[0].type;
  // Other types that also clearly match become secondary (merged later).
  const secondaryTypes = scored.slice(1).filter(s => s.score >= 1).map(s => s.type).slice(0, 2);
  const top = scored[0].score;
  const confidence = Math.min(0.95, 0.5 + top * 0.15);
  const label = secondaryTypes.length
    ? `${APP_TYPE_PROFILES[primary].label} + ${secondaryTypes.map(t => APP_TYPE_PROFILES[t].label).join(' + ')}`
    : APP_TYPE_PROFILES[primary].label;

  return { appType: primary, secondaryTypes, confidence, label, source: 'keyword' };
}

// ── 2. Capability detection (profile requirements + registry signals) ────────
export function detectCapabilities(prompt: string, intent: DetectedIntent): CapabilityId[] {
  const lower = prompt.toLowerCase();
  const caps = new Set<CapabilityId>();

  // Required capabilities from the primary + any secondary profiles (merge).
  for (const type of [intent.appType, ...intent.secondaryTypes]) {
    APP_TYPE_PROFILES[type].requiredCapabilities.forEach(c => caps.add(c));
  }
  // Add any capability explicitly implied by the prompt's wording.
  for (const id of Object.keys(SERVICE_REGISTRY) as CapabilityId[]) {
    if (SERVICE_REGISTRY[id].detectSignals.some(sig => lower.includes(sig))) caps.add(id);
  }
  return [...caps];
}

// ── 3. Resolve capabilities to provider + version (capability versioning) ────
export function resolveCapabilities(capabilities: CapabilityId[]): ResolvedCapability[] {
  return capabilities.map(id => {
    const entry = SERVICE_REGISTRY[id];
    const provider = entry.providers.find(p => p.name === entry.defaultProvider) ?? entry.providers[0];
    return {
      capability: id,
      provider: provider?.name ?? entry.defaultProvider,
      version: provider?.version ?? entry.version,
      configuration: { proxyPath: entry.proxyPath, mode: provider?.mode ?? 'platform' },
    };
  });
}

// ── 4. Page / route / component / model planning ─────────────────────────────
function planPages(intent: DetectedIntent, requiresAuth: boolean): PlannedPage[] {
  const routes = new Set<string>(['/']);
  for (const type of [intent.appType, ...intent.secondaryTypes]) {
    APP_TYPE_PROFILES[type].typicalPages.forEach(r => routes.add(r));
  }
  // ROOT CAUSE fix: forgot-password was never planned here, so nothing ever
  // told the model such a page should exist. If the model happened to write
  // a link to it from the login page anyway, the verifier's dead-link check
  // could catch it and the repairer had a working fast-path stub-fix — but
  // that only fired by luck of link-syntax matching a regex, never
  // reliably. Planning it explicitly (matching the real auth API route
  // buildAuthRoutes already generates — see services/engine/auth-template.ts)
  // makes it a guaranteed part of every auth-enabled app, not a maybe.
  if (requiresAuth) { routes.add('/login'); routes.add('/signup'); routes.add('/dashboard'); routes.add('/forgot-password'); }

  return [...routes].map(route => ({
    route,
    filePath: routeToFilePath(route),
    title: route === '/' ? 'Home' : titleCase(route.replace(/\/\[.*?\]/g, '').replace(/^\//, '')),
    purpose: route === '/' ? 'Landing / home page' : `${titleCase(route)} page`,
    dynamic: route.includes('['),
  }));
}

function planApiRoutes(pages: PlannedPage[], requiresAuth: boolean): PlannedApiRoute[] {
  const routes: PlannedApiRoute[] = [];
  const resources = new Set<string>();
  for (const p of pages) {
    const r = resourceOf(p.route);
    // 'forgot-password' excluded same as the other auth pages — it needs a
    // purpose-built reset-token endpoint, not a generic list/create CRUD route.
    if (r && !['login', 'signup', 'dashboard', 'about', 'contact', 'pricing', 'settings', 'forgot-password'].includes(r)) resources.add(r);
  }
  for (const res of resources) {
    routes.push({ route: `/api/${res}`, filePath: `app/api/${res}/route.ts`, methods: ['GET', 'POST'], purpose: `List/create ${res}` });
    routes.push({ route: `/api/${res}/[id]`, filePath: `app/api/${res}/[id]/route.ts`, methods: ['GET', 'PUT', 'DELETE'], purpose: `Read/update/delete one ${res}` });
  }
  if (requiresAuth) {
    routes.push({ route: '/api/auth/login', filePath: 'app/api/auth/login/route.ts', methods: ['POST'], purpose: 'Authenticate user' });
    routes.push({ route: '/api/auth/register', filePath: 'app/api/auth/register/route.ts', methods: ['POST'], purpose: 'Register user' });
  }
  return routes;
}

function planComponents(intent: DetectedIntent): PlannedComponent[] {
  const base: PlannedComponent[] = [
    { name: 'Navbar', filePath: 'components/Navbar.tsx', purpose: 'Top navigation with working links' },
    { name: 'Footer', filePath: 'components/Footer.tsx', purpose: 'Site footer' },
  ];
  if (intent.appType !== 'landing' && intent.appType !== 'portfolio') {
    base.push({ name: 'Card', filePath: 'components/Card.tsx', purpose: 'Reusable content/item card' });
  }
  return base;
}

function planDataModels(pages: PlannedPage[]): PlannedDataModel[] {
  const models: PlannedDataModel[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const r = resourceOf(p.route);
    if (!r || seen.has(r) || ['login', 'signup', 'dashboard', 'about', 'contact', 'pricing', 'settings'].includes(r)) continue;
    seen.add(r);
    const name = titleCase(r).replace(/s$/, '');
    models.push({ name, fields: [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'createdAt', type: 'string' },
    ] });
  }
  return models;
}

function defaultUiStyle(): UiStyle {
  return { preset: 'modern', palette: ['#7c3aed', '#2563eb', '#0f172a'], animations: true };
}

// ── Fail-safe: when classification is too weak, ask ONE clarifying question ──
/**
 * True when the request could not be confidently classified. The orchestrator
 * should ask EXACTLY ONE clarification question instead of guessing/building.
 */
export function needsClarification(intent: DetectedIntent): boolean {
  return intent.appType === 'unknown' && intent.source === 'fallback';
}

/** A single, focused question to disambiguate an unknown request. */
export function clarificationQuestion(prompt: string): string {
  const name = prompt.replace(/^(create|build|make|generate)\s+/i, '').split(/[.,\n]/)[0].trim().slice(0, 40) || 'this app';
  return `What kind of app is "${name}"? For example: an online store, a booking system, a dashboard/CRM, a marketplace, a blog, or something else?`;
}

// ── 5. Produce the full AppPlan ───────────────────────────────────────────────
export function createPlan(prompt: string, ctx: PlannerContext = {}): AppPlan {
  const intent = classifyIntent(prompt, ctx);
  const capabilities = detectCapabilities(prompt, intent);
  const requiresAuth = capabilities.includes('auth');
  const pages = planPages(intent, requiresAuth);

  const displayName = titleCase(prompt.split(/[.,\n]/)[0].slice(0, 50)) || intent.label;

  return {
    projectName: slugify(displayName),
    displayName,
    description: prompt.slice(0, 200),
    intent,
    pages,
    apiRoutes: planApiRoutes(pages, requiresAuth),
    components: planComponents(intent),
    dataModels: planDataModels(pages),
    requiresAuth,
    seo: { sitemap: capabilities.includes('seo'), robots: capabilities.includes('seo'), metadata: true, schema: capabilities.includes('seo') },
    uiStyle: defaultUiStyle(),
    capabilities,
    resolvedCapabilities: resolveCapabilities(capabilities),
  };
}
