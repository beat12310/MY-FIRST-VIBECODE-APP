/**
 * DWOMOH Vibe Code — Dynamic Registry
 *
 * Probes all entries in probe-registry.ts in parallel (concurrency cap: 20)
 * to determine which RapidAPI hosts the current RAPIDAPI_KEY is subscribed to.
 *
 * Caching strategy:
 *  - In-process: 30 minute TTL
 *  - On-disk:    .dwomoh/api-registry.json — loaded on startup if < 4 hours old
 *
 * Subscription detection:
 *  - 403 + "not subscribed" in body → NOT subscribed
 *  - Any other response → subscribed (key was accepted)
 *  - Timeout / network error → NOT subscribed (uncertain)
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROBE_REGISTRY, type ProbeEntry } from './probe-registry';
import { getRapidApiKey } from './api-manager/key-vault';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveredEntry extends ProbeEntry {
  subscribed: boolean;
  httpStatus?: number;
  responseMs: number;
  scannedAt: number;
  lastError?: string;
}

export interface DynamicRegistryResult {
  scannedAt: number;
  keyPrefix: string;
  totalProbed: number;
  totalSubscribed: number;
  entries: DiscoveredEntry[];
  byCategory: Record<string, DiscoveredEntry[]>;
  categoriesAvailable: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000;       // 30 min in-process
const DISK_TTL_MS = 4 * 60 * 60 * 1000;    // 4 hours on disk
const PROBE_TIMEOUT_MS = 8000;
const MAX_CONCURRENCY = 20;
const REGISTRY_FILE = path.join(process.cwd(), '.dwomoh', 'api-registry.json');

// ── In-process cache ──────────────────────────────────────────────────────────

interface Cache {
  result: DynamicRegistryResult;
  expiresAt: number;
  keyPrefix: string;
}

let _cache: Cache | null = null;

export function invalidateRegistry(): void {
  _cache = null;
}

// ── Semaphore ─────────────────────────────────────────────────────────────────

function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return;
    }
    await new Promise<void>(resolve => queue.push(resolve));
    active++;
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return { acquire, release };
}

// ── Disk persistence ──────────────────────────────────────────────────────────

function loadFromDisk(): DynamicRegistryResult | null {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return null;
    const stat = fs.statSync(REGISTRY_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > DISK_TTL_MS) return null;
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as DynamicRegistryResult;
    // Re-attach buildUrl functions from probe registry (they aren't serializable)
    parsed.entries = parsed.entries.map(e => {
      const probe = PROBE_REGISTRY.find(p => p.host === e.host);
      if (probe?.buildUrl) {
        return { ...e, buildUrl: probe.buildUrl };
      }
      return e;
    });
    return parsed;
  } catch {
    return null;
  }
}

function saveToDisk(result: DynamicRegistryResult): void {
  try {
    const dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Strip non-serializable functions before writing
    const serializable: DynamicRegistryResult = {
      ...result,
      entries: result.entries.map(({ buildUrl: _b, ...rest }) => rest as DiscoveredEntry),
    };
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(serializable, null, 2), 'utf8');
  } catch (err) {
    console.warn('[DynamicRegistry] Failed to write registry to disk:', err);
  }
}

// ── Core probe ────────────────────────────────────────────────────────────────

async function probeEntry(entry: ProbeEntry, key: string): Promise<DiscoveredEntry> {
  const started = Date.now();

  try {
    let url = entry.testEndpoint;
    const method = entry.testMethod || 'GET';

    if (method === 'GET' && entry.testParams) {
      url += '?' + new URLSearchParams(entry.testParams).toString();
    }

    const fetchOpts: RequestInit = {
      method,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': entry.host,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    };

    if (method === 'POST' && entry.testBody) {
      fetchOpts.body = JSON.stringify(entry.testBody);
    }

    const res = await fetch(url, fetchOpts);
    const responseMs = Date.now() - started;
    const bodyText = await res.text().catch(() => '');

    // 403 + "not subscribed" = definitely not subscribed
    if (res.status === 403 && bodyText.toLowerCase().includes('not subscribed')) {
      return {
        ...entry,
        subscribed: false,
        httpStatus: res.status,
        responseMs,
        scannedAt: Date.now(),
        lastError: 'Not subscribed',
      };
    }

    // Everything else = subscribed (key was accepted by RapidAPI gateway)
    return {
      ...entry,
      subscribed: true,
      httpStatus: res.status,
      responseMs,
      scannedAt: Date.now(),
    };

  } catch (err) {
    const responseMs = Date.now() - started;
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      ...entry,
      subscribed: false,
      responseMs,
      scannedAt: Date.now(),
      lastError: isTimeout ? `Timed out (${PROBE_TIMEOUT_MS / 1000}s)` : String(err),
    };
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function scanAllHosts(opts: { forceRefresh?: boolean } = {}): Promise<DynamicRegistryResult> {
  const key = getRapidApiKey();
  const keyPrefix = key.length > 8 ? `${key.slice(0, 8)}…` : '(no key)';

  if (!key) {
    const empty: DynamicRegistryResult = {
      scannedAt: Date.now(), keyPrefix,
      totalProbed: 0, totalSubscribed: 0,
      entries: [], byCategory: {}, categoriesAvailable: [],
    };
    return empty;
  }

  const sem = createSemaphore(MAX_CONCURRENCY);

  const probeWithSemaphore = async (entry: ProbeEntry): Promise<DiscoveredEntry> => {
    await sem.acquire();
    try {
      return await probeEntry(entry, key);
    } finally {
      sem.release();
    }
  };

  console.log(`[DynamicRegistry] Scanning ${PROBE_REGISTRY.length} hosts (concurrency: ${MAX_CONCURRENCY})…`);
  const entries = await Promise.all(PROBE_REGISTRY.map(probeWithSemaphore));

  const subscribed = entries.filter(e => e.subscribed);

  // Group into byCategory (subscribed only)
  const byCategory: Record<string, DiscoveredEntry[]> = {};
  for (const e of subscribed) {
    for (const cat of e.categories) {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(e);
    }
  }

  const result: DynamicRegistryResult = {
    scannedAt: Date.now(),
    keyPrefix,
    totalProbed: entries.length,
    totalSubscribed: subscribed.length,
    entries,
    byCategory,
    categoriesAvailable: Object.keys(byCategory).sort(),
  };

  console.log(`[DynamicRegistry] Scan complete — ${subscribed.length}/${entries.length} subscribed`);

  // Persist to disk
  saveToDisk(result);

  return result;
}

// ── Cached accessor ────────────────────────────────────────────────────────────

export async function getRegistry(opts: { forceRefresh?: boolean } = {}): Promise<DynamicRegistryResult> {
  const key = getRapidApiKey();
  const keyPrefix = key.slice(0, 8);
  const now = Date.now();

  // Return in-process cache if valid
  if (!opts.forceRefresh && _cache && _cache.expiresAt > now && _cache.keyPrefix === keyPrefix) {
    return _cache.result;
  }

  // Try loading from disk (avoids re-scan on server restart)
  if (!opts.forceRefresh) {
    const diskResult = loadFromDisk();
    if (diskResult) {
      console.log('[DynamicRegistry] Loaded from disk cache');
      _cache = { result: diskResult, expiresAt: now + CACHE_TTL_MS, keyPrefix };
      return diskResult;
    }
  }

  // Full scan
  const result = await scanAllHosts(opts);
  _cache = { result, expiresAt: now + CACHE_TTL_MS, keyPrefix };
  return result;
}

// ── Category lookup ────────────────────────────────────────────────────────────

export function getSubscribedByCategory(category: string): DiscoveredEntry[] {
  if (!_cache) return [];
  return _cache.result.byCategory[category] ?? [];
}

// ── Prompt matching ────────────────────────────────────────────────────────────

export function findBestForPrompt(prompt: string): DiscoveredEntry[] {
  if (!_cache) return [];

  const lower = prompt.toLowerCase();
  const words = lower.split(/\W+/).filter(Boolean);

  const scored: Array<{ entry: DiscoveredEntry; score: number }> = [];

  for (const entry of _cache.result.entries) {
    if (!entry.subscribed) continue;

    let score = 0;

    // Category word matches
    for (const cat of entry.categories) {
      const catWords = cat.toLowerCase().split(/[-_\s]+/);
      for (const cw of catWords) {
        if (words.includes(cw) || lower.includes(cw)) score += 2;
      }
    }

    // Name word matches
    const nameWords = entry.name.toLowerCase().split(/[\s\-\/\(\)]+/);
    for (const nw of nameWords) {
      if (nw.length > 2 && (words.includes(nw) || lower.includes(nw))) score += 1;
    }

    // Description word matches (lower weight)
    const descWords = entry.description.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    for (const dw of descWords) {
      if (words.includes(dw) || lower.includes(dw)) score += 0.5;
    }

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(s => s.entry);
}
