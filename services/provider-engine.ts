/**
 * DWOMOH Provider Engine
 *
 * Unified provider orchestration with a strict priority tier:
 *   1. AWS Native Services  (Bedrock, Cognito, S3, SES, DynamoDB)
 *   2. RapidAPI Subscribed  (dynamic-registry — your paid subscriptions)
 *   3. Approved Public APIs (free, no-key, vetted public APIs)
 *
 * Usage:
 *   const provider = await selectProvider({ need: 'live football scores' });
 *   // → { tier, name, host, callFn, ... }
 */

import { getRegistry, getSubscribedByCategory, findBestForPrompt, type DiscoveredEntry } from './dynamic-registry';
import { PUBLIC_API_REGISTRY, type PublicApiEntry } from './public-api-registry';
import { getRapidApiKey } from './api-manager/key-vault';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderTier = 'aws' | 'rapidapi' | 'public';

export interface ProviderCapability {
  /** What this provider can do — matches against user prompts */
  keywords: string[];
  /** Category tags */
  categories: string[];
  description: string;
}

export interface ResolvedProvider {
  tier: ProviderTier;
  name: string;
  host?: string;          // RapidAPI host or public API base URL
  categories: string[];
  description: string;
  requiresKey: boolean;
  keyEnvVar?: string;
  available: boolean;
  lastTestedMs?: number;
  /** For RapidAPI providers: the underlying DiscoveredEntry */
  rapidApiEntry?: DiscoveredEntry;
  /** For public APIs: the underlying PublicApiEntry */
  publicEntry?: PublicApiEntry;
  /** For AWS: the service identifier */
  awsService?: string;
}

export interface SelectProviderOpts {
  /** Free-text description of what's needed — e.g. "live football scores" */
  need: string;
  /** Explicit category override — e.g. "sports" */
  category?: string;
  /** Skip AWS tier even if a service could apply */
  skipAws?: boolean;
  /** Skip RapidAPI tier */
  skipRapidApi?: boolean;
  /** Skip public APIs tier */
  skipPublic?: boolean;
}

export interface ProviderPlan {
  primary: ResolvedProvider | null;
  alternatives: ResolvedProvider[];
  /** All tiers checked in order, with what was found */
  tierSummary: { tier: ProviderTier; found: number; reason?: string }[];
  /** Human-readable selection explanation */
  rationale: string;
}

// ── AWS service definitions ───────────────────────────────────────────────────

const AWS_SERVICES: Array<ProviderCapability & { service: string; envVars: string[] }> = [
  {
    service: 'bedrock',
    keywords: ['ai', 'llm', 'chat', 'generate text', 'summarize', 'classify', 'nlp', 'language model', 'gpt', 'claude', 'prediction', 'analysis', 'recommendation'],
    categories: ['ai', 'nlp', 'text-generation', 'summarization', 'classification'],
    description: 'AWS Bedrock — Claude AI for text generation, analysis, and AI features',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'BEDROCK_MODEL_ID'],
  },
  {
    service: 'cognito',
    keywords: ['auth', 'authentication', 'login', 'register', 'user', 'sign in', 'sign up', 'jwt', 'oauth', 'session'],
    categories: ['auth', 'authentication', 'users', 'security'],
    description: 'AWS Cognito — User authentication, registration, and session management',
    envVars: ['NEXT_PUBLIC_USER_POOL_ID', 'NEXT_PUBLIC_USER_POOL_CLIENT_ID'],
  },
  {
    service: 's3',
    keywords: ['storage', 'upload', 'file', 'image', 'video upload', 'asset', 'bucket', 'cdn'],
    categories: ['storage', 'files', 'media', 'upload'],
    description: 'AWS S3 — File and media storage with CDN delivery',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
  {
    service: 'ses',
    keywords: ['email', 'send email', 'notification', 'transactional email', 'smtp', 'mail'],
    categories: ['email', 'notifications', 'messaging'],
    description: 'AWS SES — Transactional email delivery',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DWOMOH_SES_FROM_EMAIL'],
  },
  {
    service: 'dynamodb',
    keywords: ['database', 'db', 'store data', 'persist', 'nosql', 'dynamo'],
    categories: ['database', 'storage', 'persistence'],
    description: 'AWS DynamoDB — NoSQL database for application data',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
];

function isAwsServiceAvailable(service: typeof AWS_SERVICES[number]): boolean {
  return service.envVars.every(v => {
    const val = process.env[v] || '';
    return val.length > 4 && !val.startsWith('PASTE_') && !val.startsWith('your_');
  });
}

function scoreAwsService(need: string, service: typeof AWS_SERVICES[number]): number {
  const text = need.toLowerCase();
  return service.keywords.filter(k => text.includes(k)).length;
}

// ── Core selection logic ──────────────────────────────────────────────────────

let _cachedRegistry: Awaited<ReturnType<typeof getRegistry>> | null = null;

async function loadRegistry() {
  if (_cachedRegistry) return _cachedRegistry;
  try {
    _cachedRegistry = await getRegistry();
    return _cachedRegistry;
  } catch {
    return null;
  }
}

function toResolvedProvider(entry: DiscoveredEntry): ResolvedProvider {
  return {
    tier: 'rapidapi',
    name: entry.name,
    host: entry.host,
    categories: entry.categories,
    description: entry.description,
    requiresKey: true,
    keyEnvVar: 'RAPIDAPI_KEY',
    available: entry.subscribed,
    lastTestedMs: entry.scannedAt,
    rapidApiEntry: entry,
  };
}

function toPublicResolved(entry: PublicApiEntry): ResolvedProvider {
  return {
    tier: 'public',
    name: entry.name,
    host: entry.baseUrl,
    categories: entry.categories,
    description: entry.description,
    requiresKey: false,
    available: true,
    publicEntry: entry,
  };
}

/**
 * Select the best available provider for a given need.
 * Searches all three tiers in priority order and returns a ranked plan.
 */
export async function selectProvider(opts: SelectProviderOpts): Promise<ProviderPlan> {
  const { need, category, skipAws = false, skipRapidApi = false, skipPublic = false } = opts;
  const needLower = need.toLowerCase();
  const tierSummary: ProviderPlan['tierSummary'] = [];
  const alternatives: ResolvedProvider[] = [];
  let primary: ResolvedProvider | null = null;

  // ── Tier 1: AWS ─────────────────────────────────────────────────────────────
  if (!skipAws) {
    const awsMatches = AWS_SERVICES
      .map(svc => ({ svc, score: scoreAwsService(needLower, svc) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    tierSummary.push({ tier: 'aws', found: awsMatches.length });

    for (const { svc } of awsMatches) {
      const avail = isAwsServiceAvailable(svc);
      const resolved: ResolvedProvider = {
        tier: 'aws',
        name: svc.description.split(' — ')[0],
        categories: svc.categories,
        description: svc.description,
        requiresKey: true,
        keyEnvVar: svc.envVars[0],
        available: avail,
        awsService: svc.service,
      };
      if (!primary && avail) primary = resolved;
      else alternatives.push(resolved);
    }
  }

  // ── Tier 2: RapidAPI ────────────────────────────────────────────────────────
  if (!skipRapidApi && getRapidApiKey()) {
    const registry = await loadRegistry();
    let rapidMatches: DiscoveredEntry[] = [];

    if (registry) {
      // Use findBestForPrompt for keyword matching, then supplement with category
      rapidMatches = findBestForPrompt(need).filter(e => e.subscribed);
      if (category) {
        const byCat = getSubscribedByCategory(category).filter(
          e => !rapidMatches.some(m => m.host === e.host)
        );
        rapidMatches = [...rapidMatches, ...byCat];
      }
    }

    tierSummary.push({ tier: 'rapidapi', found: rapidMatches.length });

    for (const entry of rapidMatches) {
      const resolved = toResolvedProvider(entry);
      if (!primary) primary = resolved;
      else alternatives.push(resolved);
    }
  } else {
    tierSummary.push({ tier: 'rapidapi', found: 0, reason: 'RAPIDAPI_KEY not configured' });
  }

  // ── Tier 3: Public APIs ──────────────────────────────────────────────────────
  if (!skipPublic) {
    const pubMatches = PUBLIC_API_REGISTRY.filter(entry => {
      const combined = [...entry.categories, ...entry.keywords].join(' ').toLowerCase();
      return needLower.split(/\s+/).some(word => word.length > 3 && combined.includes(word));
    });

    tierSummary.push({ tier: 'public', found: pubMatches.length });

    for (const entry of pubMatches) {
      const resolved = toPublicResolved(entry);
      if (!primary) primary = resolved;
      else alternatives.push(resolved);
    }
  }

  // Build rationale
  let rationale: string;
  if (!primary) {
    rationale = `No provider found for: "${need}". Searched ${tierSummary.map(t => `${t.tier}(${t.found})`).join(', ')}.`;
  } else {
    rationale = `Selected ${primary.name} [${primary.tier}] for "${need}". ${alternatives.length} alternative(s) available.`;
  }

  return { primary, alternatives, tierSummary, rationale };
}

/**
 * Find all available providers for a category across all tiers.
 */
export async function allProvidersForCategory(category: string): Promise<ResolvedProvider[]> {
  const results: ResolvedProvider[] = [];

  // AWS
  for (const svc of AWS_SERVICES) {
    if (svc.categories.some(c => c === category || c.includes(category))) {
      results.push({
        tier: 'aws',
        name: svc.description.split(' — ')[0],
        categories: svc.categories,
        description: svc.description,
        requiresKey: true,
        available: isAwsServiceAvailable(svc),
        awsService: svc.service,
      });
    }
  }

  // RapidAPI
  if (getRapidApiKey()) {
    await loadRegistry();
    const entries = getSubscribedByCategory(category);
    results.push(...entries.map(toResolvedProvider));
  }

  // Public
  const pubEntries = PUBLIC_API_REGISTRY.filter(e => e.categories.includes(category));
  results.push(...pubEntries.map(toPublicResolved));

  return results;
}

/**
 * Full status snapshot — used by the provider dashboard.
 */
export async function getProviderStatus() {
  const key = getRapidApiKey();
  const registry = key ? await loadRegistry() : null;

  // AWS summary
  const awsSummary = AWS_SERVICES.map(svc => ({
    service: svc.service,
    name: svc.description.split(' — ')[0],
    description: svc.description,
    categories: svc.categories,
    available: isAwsServiceAvailable(svc),
    requiredVars: svc.envVars,
  }));

  return {
    aws: {
      services: awsSummary,
      totalAvailable: awsSummary.filter(s => s.available).length,
      totalConfigured: awsSummary.length,
    },
    rapidapi: {
      keyPrefix: key ? `${key.slice(0, 8)}…` : null,
      keyConfigured: !!key,
      totalSubscribed: registry?.totalSubscribed ?? 0,
      totalProbed: registry?.totalProbed ?? 0,
      categoriesAvailable: registry?.categoriesAvailable ?? [],
      lastScanned: registry?.scannedAt ?? null,
    },
    public: {
      totalAvailable: PUBLIC_API_REGISTRY.length,
      categories: [...new Set(PUBLIC_API_REGISTRY.flatMap(e => e.categories))].sort(),
    },
    tiers: [
      { tier: 'aws' as ProviderTier, label: 'AWS Native', priority: 1, ready: awsSummary.some(s => s.available) },
      { tier: 'rapidapi' as ProviderTier, label: 'RapidAPI Subscriptions', priority: 2, ready: !!key && (registry?.totalSubscribed ?? 0) > 0 },
      { tier: 'public' as ProviderTier, label: 'Approved Public APIs', priority: 3, ready: true },
    ],
  };
}
