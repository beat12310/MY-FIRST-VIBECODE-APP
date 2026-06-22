/**
 * DWOMOH API Discovery Engine
 *
 * Probes every catalog entry in parallel to find which ones the current
 * RAPIDAPI_KEY has active subscriptions for. Results are cached in-process
 * with a configurable TTL so we never repeat the scan on every request.
 *
 * Usage:
 *   const disco = await getDiscovery();         // cached or fresh scan
 *   const host  = disco.bestHostFor('weather'); // first working host, or null
 */

import { API_CATALOG, type ApiCategory, type ApiEntry, updateEntryStatus } from './api-catalog';
import { getRapidApiKey } from './api-manager/key-vault';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderResult {
  id: string;
  name: string;
  category: ApiCategory;
  host: string;
  ok: boolean;
  /** HTTP status returned by RapidAPI */
  status?: number;
  /** Short extract from the response (for display) */
  preview?: string;
  error?: string;
  latencyMs: number;
}

export interface DiscoveryResult {
  scannedAt: number;
  keyPrefix: string;
  totalTested: number;
  totalWorking: number;
  /** All results, one per catalog entry */
  results: ProviderResult[];
  /** Working providers grouped by category */
  byCategory: Partial<Record<ApiCategory, ProviderResult[]>>;
  /** True when at least one provider was found for any category */
  hasAnyWorking: boolean;
}

// ── In-process cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Cache {
  result: DiscoveryResult;
  expiresAt: number;
  keyPrefix: string; // invalidate if key changes
}

let _cache: Cache | null = null;

export function invalidateDiscoveryCache(): void {
  _cache = null;
}

// ── Core probe ────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 8000;

async function probeEntry(entry: ApiEntry, key: string): Promise<ProviderResult> {
  const started = Date.now();
  const base: Omit<ProviderResult, 'ok' | 'latencyMs' | 'status' | 'preview' | 'error'> = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    host: entry.rapidApiHost,
  };

  try {
    let url = entry.testEndpoint;
    if (entry.testParams && entry.testMethod !== 'POST') {
      url += '?' + new URLSearchParams(entry.testParams).toString();
    }

    const fetchOpts: RequestInit = {
      method: entry.testMethod || 'GET',
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': entry.rapidApiHost,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    };
    if (entry.testMethod === 'POST' && entry.testBody) {
      fetchOpts.body = JSON.stringify(entry.testBody);
    }

    const res = await fetch(url, fetchOpts);
    const latencyMs = Date.now() - started;
    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text().catch(() => '');

    if (!res.ok) {
      const errShort = bodyText.slice(0, 120).replace(/\n/g, ' ');
      const isNotSubscribed =
        res.status === 403 && bodyText.toLowerCase().includes('not subscribed');
      // 429 = Too Many Requests — the key IS subscribed, just hitting rate limits.
      // Treat as working (subscribed) so it appears in byCategory and gets used.
      const isRateLimited = res.status === 429;

      if (isRateLimited) {
        updateEntryStatus(entry.id, { status: 'working' });
        return { ...base, ok: true, status: res.status, preview: '(rate limited — subscribed)', latencyMs };
      }

      updateEntryStatus(entry.id, {
        status: isNotSubscribed ? 'needs_setup' : 'failed',
        error: errShort,
      });
      return { ...base, ok: false, status: res.status, error: errShort, latencyMs };
    }

    // Parse and validate
    let data: unknown = bodyText;
    if (ct.includes('json')) {
      try { data = JSON.parse(bodyText); } catch { /* keep string */ }
    }

    const valid = entry.responseValidator(data);
    const preview = valid && entry.responsePreview ? entry.responsePreview(data) : undefined;

    updateEntryStatus(entry.id, {
      status: valid ? 'working' : 'failed',
      error: valid ? undefined : 'Response shape mismatch',
    });

    return { ...base, ok: valid, status: res.status, preview, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const error = isTimeout ? `Timed out (${PROBE_TIMEOUT_MS / 1000}s)` : String(err);
    updateEntryStatus(entry.id, { status: 'failed', error });
    return { ...base, ok: false, error, latencyMs };
  }
}

// ── Main discovery function ───────────────────────────────────────────────────

/**
 * Probe every catalog entry in parallel and return structured results.
 * This is the raw scan — use `getDiscovery()` for the cached version.
 */
export async function scanAllProviders(): Promise<DiscoveryResult> {
  const key = getRapidApiKey();
  const keyPrefix = key.length > 8 ? `${key.slice(0, 8)}…` : '(no key)';

  if (!key) {
    const empty: DiscoveryResult = {
      scannedAt: Date.now(), keyPrefix, totalTested: 0, totalWorking: 0,
      results: [], byCategory: {}, hasAnyWorking: false,
    };
    return empty;
  }

  // Run all probes in parallel
  const results = await Promise.all(
    API_CATALOG.map(entry => probeEntry(entry, key))
  );

  const working = results.filter(r => r.ok);

  const byCategory: Partial<Record<ApiCategory, ProviderResult[]>> = {};
  for (const r of working) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category]!.push(r);
  }

  return {
    scannedAt: Date.now(),
    keyPrefix,
    totalTested: results.length,
    totalWorking: working.length,
    results,
    byCategory,
    hasAnyWorking: working.length > 0,
  };
}

/**
 * Return cached discovery results, re-scanning only if the cache is stale
 * or the API key has changed.
 */
export async function getDiscovery(opts: { forceRefresh?: boolean } = {}): Promise<DiscoveryResult> {
  const key = getRapidApiKey();
  const keyPrefix = key.slice(0, 8);
  const now = Date.now();

  if (
    !opts.forceRefresh &&
    _cache &&
    _cache.expiresAt > now &&
    _cache.keyPrefix === keyPrefix
  ) {
    return _cache.result;
  }

  const result = await scanAllProviders();
  _cache = { result, expiresAt: now + CACHE_TTL_MS, keyPrefix };
  return result;
}

/**
 * Return the best (first) working host for a category, or null.
 * Uses the in-process cache — kicks off a background scan if cold.
 */
export async function bestHostFor(category: ApiCategory): Promise<string | null> {
  const disco = await getDiscovery();
  const providers = disco.byCategory[category];
  return providers?.[0]?.host ?? null;
}

/**
 * Return all working hosts for a category in priority order.
 */
export async function allHostsFor(category: ApiCategory): Promise<string[]> {
  const disco = await getDiscovery();
  return (disco.byCategory[category] ?? []).map(p => p.host);
}

/**
 * Return a human-readable summary of the discovery result for logging.
 */
export function formatDiscoverySummary(d: DiscoveryResult): string {
  const lines = [
    `Discovery scan — key: ${d.keyPrefix} — ${d.totalWorking}/${d.totalTested} providers active`,
  ];
  for (const [cat, providers] of Object.entries(d.byCategory) as [ApiCategory, ProviderResult[]][]) {
    lines.push(`  ${cat}: ${providers.map(p => p.name).join(', ')}`);
  }
  if (d.totalWorking === 0) {
    lines.push('  No active subscriptions found for this key.');
  }
  return lines.join('\n');
}
