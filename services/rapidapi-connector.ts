/**
 * DWOMOH Vibe Code — RapidAPI Connector Engine
 *
 * Platform-level connector that:
 * 1. Detects which API categories a build prompt needs
 * 2. Picks the best provider from the catalog
 * 3. Tests the provider before using it
 * 4. Falls back to the next provider if the test fails
 * 5. Returns a clear structured error if no provider works
 *
 * The RAPIDAPI_KEY is read ONLY from process.env — never from the browser.
 */

import {
  type ApiCategory,
  type ApiEntry,
  type ApiStatus,
  API_CATALOG,
  getProviders,
  updateEntryStatus,
} from './api-catalog';
import { getDiscovery } from './api-discovery';

// ─── Key access ───────────────────────────────────────────────────────────────

// Placeholder detection — mirrors key-vault.ts isLiveKey() to stay consistent.
// Both must agree on what counts as a real key so the status page is accurate.
function isLiveKey(val: string): boolean {
  return val.length > 8 && !val.startsWith('PASTE_') && !val.startsWith('your_') && !val.startsWith('sk_test_placeholder');
}

export function getRapidApiKey(): string {
  const val = process.env.RAPIDAPI_KEY || '';
  return isLiveKey(val) ? val : '';
}

export function isRapidApiConfigured(): boolean {
  return getRapidApiKey().length > 0;
}

// ─── Category detection ───────────────────────────────────────────────────────

const CATEGORY_SIGNALS: Record<ApiCategory, string[]> = {
  video_downloader: [
    'tiktok', 'download', 'downloader', 'youtube', 'instagram', 'facebook video',
    'twitter video', 'reel', 'shorts', 'video download', 'save video', 'media downloader',
  ],
  music: [
    'shazam', 'music', 'song', 'artist', 'album', 'playlist', 'track', 'lyrics',
    'music recognition', 'sound recognition', 'identify song', 'music search', 'music player',
    'spotify', 'audio', 'streaming music', 'music app',
  ],
  weather: [
    'weather', 'forecast', 'temperature', 'rain', 'humidity', 'wind', 'climate',
    'weather app', 'weather dashboard', 'weather widget', 'weather api',
    'current weather', 'weather report',
  ],
  sports: [
    'football', 'soccer', 'basketball', 'cricket', 'tennis', 'sports',
    'live score', 'live scores', 'match', 'fixtures', 'standings', 'league',
    'prediction', 'sports app', 'score tracker', 'bet', 'betting',
  ],
  finance: [
    'currency', 'exchange rate', 'forex', 'convert currency', 'currency converter',
    'crypto', 'bitcoin', 'ethereum', 'cryptocurrency', 'price tracker', 'coin price',
    'stock', 'finance', 'money converter', 'usd to', 'eur to', 'ghs to',
  ],
  news: [
    'news', 'articles', 'headlines', 'breaking news', 'latest news', 'news feed',
    'news app', 'news dashboard', 'news aggregator', 'blog reader', 'rss',
  ],
  ai_tools: [
    'ai tool', 'chatgpt', 'gpt', 'ai chat', 'summarize', 'text generation',
    'ai writing', 'content generator', 'ai assistant', 'chatbot',
  ],
  maps: [
    'map', 'location', 'geocode', 'address lookup', 'coordinates', 'place search',
    'nearby', 'distance', 'directions',
  ],
  translate: [
    'translate', 'translation', 'language', 'multilingual', 'localization',
  ],
};

/**
 * Detect which API categories are likely needed for a build prompt.
 * Returns an ordered list (most likely first).
 */
export function detectRequiredApis(prompt: string): ApiCategory[] {
  const lower = prompt.toLowerCase();
  const scores: Array<{ category: ApiCategory; score: number }> = [];

  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    const score = signals.reduce((n, signal) => n + (lower.includes(signal) ? 1 : 0), 0);
    if (score > 0) scores.push({ category: category as ApiCategory, score });
  }

  return scores.sort((a, b) => b.score - a.score).map(s => s.category);
}

// ─── Test runner ──────────────────────────────────────────────────────────────

export interface TestResult {
  ok: boolean;
  status?: number;
  error?: string;
  preview?: string;
  responseTime?: number;
}

/**
 * Make a real test request to a provider endpoint.
 * Returns ok=true only when the response passes the entry's responseValidator.
 */
export async function testProvider(entry: ApiEntry, key: string): Promise<TestResult> {
  if (!key) {
    return { ok: false, error: 'RAPIDAPI_KEY not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const started = Date.now();

  try {
    let url = entry.testEndpoint;
    if (entry.testParams && entry.testMethod !== 'POST') {
      const params = new URLSearchParams(entry.testParams);
      url = `${url}?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': entry.rapidApiHost,
      'Content-Type': 'application/json',
    };

    const fetchOpts: RequestInit = {
      method: entry.testMethod || 'GET',
      headers,
      signal: controller.signal,
    };

    if (entry.testMethod === 'POST' && entry.testBody) {
      fetchOpts.body = JSON.stringify(entry.testBody);
    }

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);
    const responseTime = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errDetail = text.slice(0, 200).replace(/\n/g, ' ');
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${errDetail || res.statusText}`,
        responseTime,
      };
    }

    let data: unknown;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      if (!text.trim()) return { ok: false, status: res.status, error: 'Empty response body', responseTime };
      if (text.trimStart().startsWith('<')) return { ok: false, status: res.status, error: 'API returned HTML instead of JSON', responseTime };
      data = text;
    }

    if (!entry.responseValidator(data)) {
      return {
        ok: false,
        status: res.status,
        error: 'Response shape did not match expected format',
        responseTime,
      };
    }

    const preview = entry.responsePreview ? entry.responsePreview(data) : undefined;
    return { ok: true, status: res.status, preview, responseTime };

  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: isAbort ? 'Request timed out (10s)' : err instanceof Error ? err.message : 'Request failed',
      responseTime: Date.now() - started,
    };
  }
}

// ─── Provider selection ───────────────────────────────────────────────────────

export interface SelectedProvider {
  entry: ApiEntry;
  testResult: TestResult;
}

/**
 * Find the first working provider for a category.
 *
 * Strategy:
 * 1. Check the in-process discovery cache (warm after first scan).
 *    If the cache has confirmed working hosts for this category, return the
 *    best one immediately — no live test needed.
 * 2. If the cache is cold (first call) or has no result for this category,
 *    fall back to sequential live-testing (original behavior) and let the
 *    discovery engine warm on the next background scan.
 */
export async function findWorkingProvider(
  category: ApiCategory,
  key: string,
): Promise<SelectedProvider | null> {
  // ── 1. Try discovery cache ────────────────────────────────────────────────
  try {
    const disco = await getDiscovery();
    const cached = disco.byCategory[category];
    if (cached && cached.length > 0) {
      const providers = getProviders(category);
      for (const cp of cached) {
        const entry = providers.find(p => p.rapidApiHost === cp.host);
        if (entry) {
          entry.usageCount = (entry.usageCount ?? 0) + 1;
          updateEntryStatus(entry.id, { status: 'working' });
          return {
            entry,
            testResult: { ok: true, status: 200, preview: cp.preview, responseTime: cp.latencyMs },
          };
        }
      }
    }
  } catch {
    // Discovery unavailable — fall through to live testing
  }

  // ── 2. Sequential live testing (cold-cache fallback) ─────────────────────
  const providers = getProviders(category);
  for (const entry of providers) {
    const result = await testProvider(entry, key);

    let status: ApiStatus;
    if (result.ok) {
      status = 'working';
      entry.usageCount = (entry.usageCount ?? 0) + 1;
    } else if (!key) {
      status = 'needs_setup';
    } else {
      status = 'failed';
    }
    updateEntryStatus(entry.id, { status, error: result.error });

    if (result.ok) return { entry, testResult: result };
  }

  return null;
}

// ─── Build-time API resolution ────────────────────────────────────────────────

export interface ResolvedApi {
  category: ApiCategory;
  provider: SelectedProvider;
  envVarName: string;
}

export interface ApiResolutionResult {
  resolved: ResolvedApi[];
  missing: ApiCategory[];
  promptInstructions: string;
  envLines: string[];
}

/**
 * For a given build prompt:
 * 1. Detect required API categories
 * 2. Find a working provider for each
 * 3. Return structured result including what to inject into the build prompt
 */
export async function resolveApisForPrompt(prompt: string): Promise<ApiResolutionResult> {
  const key = getRapidApiKey();
  const categories = detectRequiredApis(prompt);

  const resolved: ResolvedApi[] = [];
  const missing: ApiCategory[] = [];

  for (const category of categories) {
    const selected = await findWorkingProvider(category, key);
    if (selected) {
      resolved.push({
        category,
        provider: selected,
        envVarName: `RAPIDAPI_HOST_${category.toUpperCase()}`,
      });
    } else {
      missing.push(category);
    }
  }

  const keyIsSet = key.length > 10;
  const promptInstructions = buildPromptInstructions(resolved, missing, keyIsSet);
  const envLines = buildEnvLines(resolved, key);

  return { resolved, missing, promptInstructions, envLines };
}

function buildPromptInstructions(
  resolved: ResolvedApi[],
  missing: ApiCategory[],
  keyIsSet: boolean,
): string {
  if (resolved.length === 0 && missing.length === 0) return '';

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════',
    'RAPIDAPI INTEGRATION — PLATFORM CONFIG (INJECTED BY PLATFORM)',
    '═══════════════════════════════════════════════════════════',
    '',
    'RAPIDAPI_KEY is pre-configured in process.env.RAPIDAPI_KEY.',
    'It is NEVER exposed to the browser — use it ONLY in server-side route handlers.',
    '',
    'RULE: All external API calls MUST go through local Next.js API routes.',
    '  ✅ Frontend calls: /api/integrations/[feature] (local route)',
    '  ✅ Local route calls: RapidAPI with process.env.RAPIDAPI_KEY',
    '  ❌ Never: fetch("https://api.rapidapi.com/...") from a React component',
    '',
  ];

  if (resolved.length > 0) {
    lines.push('SELECTED PROVIDERS — USE THESE EXACTLY:');
    for (const r of resolved) {
      const host = r.provider.entry.rapidApiHost;
      lines.push('');
      lines.push(`Category: ${r.category}`);
      lines.push(`Provider: ${r.provider.entry.name}`);
      lines.push(`Host: ${host}`);
      lines.push(`Hint: ${r.provider.entry.promptHint}`);
      lines.push('');
      lines.push('Required headers for every call to this API:');
      lines.push(`  "X-RapidAPI-Key": process.env.RAPIDAPI_KEY`);
      lines.push(`  "X-RapidAPI-Host": "${host}"`);
    }
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push('MISSING PROVIDERS — NO WORKING PROVIDER FOUND:');
    for (const cat of missing) {
      lines.push(`  ⚠️ ${cat}: ${keyIsSet ? 'API tested but all providers failed' : 'RAPIDAPI_KEY not configured'}`);
      lines.push(`  → Show user: "Missing external API: ${cat}. Please connect a working provider."`);
      lines.push(`  → DO NOT fake this feature. Disable the UI for it and show the error message.`);
    }
  }

  lines.push('');
  lines.push('ROUTE NAMING — follow this exact pattern for generated local routes:');
  lines.push('  /api/integrations/tiktok-download  → wraps video downloader API');
  lines.push('  /api/integrations/weather          → wraps weather API');
  lines.push('  /api/integrations/music            → wraps music/Shazam API');
  lines.push('  /api/integrations/sports           → wraps sports/scores API');
  lines.push('  /api/integrations/currency         → wraps currency exchange API');
  lines.push('  /api/integrations/news             → wraps news API');
  lines.push('═══════════════════════════════════════════════════════════');

  return lines.join('\n');
}

function buildEnvLines(resolved: ResolvedApi[], key: string): string[] {
  const lines: string[] = [];
  if (!key) return lines;

  lines.push('# RapidAPI — platform-managed key (forwarded by DWOMOH Vibe Code)');
  lines.push(`RAPIDAPI_KEY=${key}`);

  for (const r of resolved) {
    lines.push(`RAPIDAPI_HOST_${r.category.toUpperCase()}=${r.provider.entry.rapidApiHost}`);
  }

  return lines;
}

// ─── Proxy request helper (used by integration routes) ───────────────────────

export interface ProxyRequest {
  url: string;
  host: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

/**
 * Make a proxied request to RapidAPI using the platform key.
 * Used by the integration routes in app/api/integrations/*.
 */
export async function proxyRapidApi(req: ProxyRequest): Promise<ProxyResponse> {
  const key = getRapidApiKey();
  if (!key) {
    return { ok: false, status: 503, error: 'RAPIDAPI_KEY is not configured on this platform.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 15000);

  try {
    let url = req.url;
    if (req.params && req.method !== 'POST') {
      url = `${url}?${new URLSearchParams(req.params).toString()}`;
    }

    const res = await fetch(url, {
      method: req.method || 'GET',
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': req.host,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const isJson = ct.includes('json');

    if (!res.ok) {
      const errText = isJson ? JSON.stringify(await res.json().catch(() => null)) : await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `RapidAPI returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = isJson ? await res.json() : await res.text();
    return { ok: true, status: res.status, data };

  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 504,
      error: isAbort ? 'Request timed out (15s)' : err instanceof Error ? err.message : 'Request failed',
    };
  }
}
