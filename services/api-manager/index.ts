/**
 * DWOMOH API Manager — Central Facade
 *
 * This is the single entry point for all API management operations.
 * It coordinates: key vault → discovery → provider selection → testing → code generation → project storage.
 *
 * Usage from app/api/chat/route.ts:
 *   const mgr = ApiManager.instance();
 *   const plan = await mgr.planForPrompt(buildUserMessage, projectId);
 *   // plan.promptInstructions → inject into AI build prompt
 *   // plan.routes            → ready-to-write integration route files
 *   // plan.envAdditions      → lines to add to project's .env.local
 */

import { getAllProviders, getRapidApiKey, isProviderConfigured, FORWARD_ENV_VARS, getKey } from './key-vault';
import { saveProjectConfig, getProjectConfig, initProjectConfig, updateApiStatus, type ProjectApiConfig } from './project-store';
import { generateIntegrationRoute, generateEnvAdditions, type GeneratedRoute } from './generator';
import { detectRequiredApis, findWorkingProvider, proxyRapidApi, type SelectedProvider } from '../rapidapi-connector';
import { allHostsFor } from '../api-discovery';
import { getProviders } from '../api-catalog';
import { getRegistry, findBestForPrompt, getSubscribedByCategory } from '../dynamic-registry';
import { getProbeEntryByHost } from '../probe-registry';

export interface ApiPlan {
  /** Categories that have a working provider */
  resolved: Array<{ category: string; host: string; providerName: string; providerId: string }>;
  /** Categories where no provider worked */
  missing: string[];
  /** Append to the AI build prompt */
  promptInstructions: string;
  /** Route files to write into the generated project */
  routes: GeneratedRoute[];
  /** Lines to append to the generated project's .env.local */
  envAdditions: string[];
  /** Keys to forward from platform env to generated project's env */
  forwardedKeys: Array<{ envVar: string; value: string; comment: string }>;
}

export interface ProxyCallRequest {
  projectId: string;
  category: string;
  params?: Record<string, string | number | boolean>;
  body?: unknown;
  method?: 'GET' | 'POST';
}

export interface ProxyCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  provider?: string;
}

class ApiManager {
  private static _instance: ApiManager;

  static instance(): ApiManager {
    if (!ApiManager._instance) ApiManager._instance = new ApiManager();
    return ApiManager._instance;
  }

  /** Returns provider status for the UI — safe to send to browser. */
  getProviderStatus() {
    return getAllProviders();
  }

  /** True when RAPIDAPI_KEY is configured. */
  get rapidApiReady(): boolean {
    return isProviderConfigured('rapidapi');
  }

  /**
   * Full pipeline: detect what APIs a build prompt needs, test providers,
   * select working ones, and return a plan (prompt injection + route files + env).
   */
  async planForPrompt(prompt: string, projectId: string, platformPort = 3000): Promise<ApiPlan> {
    const key = getRapidApiKey();
    const categories = detectRequiredApis(prompt);

    const resolved: ApiPlan['resolved'] = [];
    const missing: string[] = [];
    const routes: GeneratedRoute[] = [];

    // Load the dynamic registry (loads from disk cache on server restart, scans lazily if cold)
    // We don't await a full scan here — getRegistry() uses cache and only scans once.
    let registry = null;
    try {
      registry = await getRegistry();
    } catch {
      // Registry not available yet — fall back to legacy findWorkingProvider
    }

    for (const category of categories) {
      let resolvedHost: string | null = null;
      let providerName = '';
      let providerId = '';

      // 1. Try dynamic registry first (knows subscription status from last scan)
      if (registry) {
        // Find best matching subscribed entry for this category
        const dynamicMatch = findBestForPrompt(prompt).find(e => e.categories.includes(category))
          ?? getSubscribedByCategory(category)[0];

        if (dynamicMatch) {
          resolvedHost = dynamicMatch.host;
          providerName = dynamicMatch.name;
          providerId = dynamicMatch.host; // use host as stable ID
          console.log(`[ApiManager] Dynamic registry selected: ${providerName} for ${category}`);
        }
      }

      // 2. Fall back to legacy catalog probe if dynamic registry didn't find anything
      if (!resolvedHost) {
        const selected: SelectedProvider | null = await findWorkingProvider(category, key);
        if (selected) {
          const entry = selected.entry;
          resolvedHost = entry.rapidApiHost;
          providerName = entry.name;
          providerId = entry.id;
        }
      }

      if (resolvedHost) {
        resolved.push({
          category,
          host: resolvedHost,
          providerName,
          providerId,
        });
        // For test endpoint and params, prefer probe-registry entry, then catalog entry
        const probeEntry = getProbeEntryByHost(resolvedHost);
        routes.push(generateIntegrationRoute(
          category,
          resolvedHost,
          probeEntry?.testEndpoint ?? `https://${resolvedHost}`,
          probeEntry?.testParams,
        ));
      } else {
        missing.push(category);
      }
    }

    const promptInstructions = this._buildPromptInstructions(resolved, missing, platformPort, projectId);
    const envAdditions = generateEnvAdditions(resolved.map(r => r.category), platformPort, projectId);
    const forwardedKeys = this._buildForwardedKeys();

    // Persist plan to project store
    if (categories.length > 0) {
      const existing = await getProjectConfig(projectId) ?? await initProjectConfig(projectId, '', platformPort);
      const updatedApis = [
        ...existing.apis.filter(a => !categories.includes(a.category as import('../api-catalog').ApiCategory)),
        ...resolved.map(r => ({
          category: r.category,
          providerId: r.providerId,
          providerName: r.providerName,
          rapidApiHost: r.host,
          status: 'working' as const,
          testedAt: new Date().toISOString(),
        })),
        ...missing.map(cat => ({
          category: cat,
          providerId: '',
          providerName: 'None',
          status: 'failed' as const,
          testedAt: new Date().toISOString(),
          errorMessage: 'No working provider found',
        })),
      ];
      await saveProjectConfig({ ...existing, apis: updatedApis, platformPort });
    }

    // For missing categories that have a free fallback API, add the pre-built route
    // so generated apps work out of the box without any credentials.
    for (const cat of missing) {
      const fallback = FREE_API_FALLBACKS[cat];
      if (fallback && !routes.some(r => r.path === fallback.routeFile)) {
        routes.push({ path: fallback.routeFile, content: fallback.route });
        console.log(`[ApiManager] Injecting free fallback route for: ${cat} → ${fallback.routeFile}`);
      }
    }

    return { resolved, missing, promptInstructions, routes, envAdditions, forwardedKeys };
  }

  /**
   * Proxy a real API call on behalf of a generated app.
   * The generated app sends { projectId, category, params } — we look up the
   * project config, find the right provider + host, and make the external call.
   * RAPIDAPI_KEY never leaves the platform.
   */
  async proxyCall(req: ProxyCallRequest): Promise<ProxyCallResult> {
    const { projectId, category, params = {}, body, method = 'GET' } = req;

    // Load project config to find selected provider
    const config = await getProjectConfig(projectId);
    const apiEntry = config?.apis.find(a => a.category === category);

    const key = getRapidApiKey();
    if (!key) {
      return { ok: false, error: 'RAPIDAPI_KEY is not configured in the platform.' };
    }

    // Build ordered list of hosts to try:
    //   1. Project-configured host (most specific)
    //   2. Dynamic registry subscribed hosts for this category
    //   3. Legacy discovery-confirmed working hosts
    //   4. First catalog entry as last resort
    const configuredHost = apiEntry?.rapidApiHost;

    // Dynamic registry subscribed hosts for this category
    const dynamicHosts = getSubscribedByCategory(category).map(e => e.host);

    // Legacy discovery hosts
    const discoveredHosts = await allHostsFor(category as Parameters<typeof allHostsFor>[0]).catch(() => [] as string[]);

    const fallbackHost = (() => {
      const providers = getProviders(category as Parameters<typeof getProviders>[0]);
      return providers[0]?.rapidApiHost;
    })();

    const hostsToTry: string[] = [];
    if (configuredHost) hostsToTry.push(configuredHost);
    for (const h of [...dynamicHosts, ...discoveredHosts]) {
      if (!hostsToTry.includes(h)) hostsToTry.push(h);
    }
    if (fallbackHost && !hostsToTry.includes(fallbackHost)) hostsToTry.push(fallbackHost);

    if (hostsToTry.length === 0) {
      return { ok: false, error: `No provider configured for category: ${category}` };
    }

    // Try each host in order; on 403/401 (subscription error) move to next.
    let lastResult: Awaited<ReturnType<typeof proxyRapidApi>> = { ok: false, error: 'No hosts tried', status: 500 };
    let winningHost: string | undefined;

    for (const host of hostsToTry) {
      // Prefer buildUrl from probe-registry if available; fall back to _categoryToUrl
      const probeEntry = getProbeEntryByHost(host);
      const apiUrl = probeEntry?.buildUrl
        ? probeEntry.buildUrl(params as Record<string, string>)
        : this._categoryToUrl(category, host, params as Record<string, string>);
      if (!apiUrl) continue;

      const result = await proxyRapidApi({
        url: apiUrl.url,
        host,
        method: method as 'GET' | 'POST',
        params: apiUrl.params,
        body,
      });

      lastResult = result;

      if (result.ok) {
        winningHost = host;
        break;
      }

      const isSubscriptionError = result.status === 403 || result.status === 401;
      if (!isSubscriptionError) {
        // Non-subscription error (500, network, etc.) — don't retry with another host
        winningHost = host;
        break;
      }

      console.log(`[ApiManager] ${host} returned ${result.status} — trying next provider for ${category}`);
    }

    const chosenHost = winningHost ?? hostsToTry[0];

    // Update project config with this usage
    await updateApiStatus(projectId, category, {
      status: lastResult.ok ? 'working' : 'failed',
      errorMessage: lastResult.error,
    }).catch(() => {});

    // Normalize provider-specific response shapes into a consistent format
    // so generated app routes don't need to know which provider won.
    const normalized = lastResult.ok
      ? this._normalizeResponse(category, lastResult.data, params as Record<string, string>)
      : lastResult.data;

    return {
      ok: lastResult.ok,
      data: normalized,
      error: lastResult.error,
      provider: chosenHost,
    };
  }

  /**
   * Normalize raw provider responses into a consistent shape per category.
   * Generated app routes receive these normalized shapes — they never need
   * to know which specific RapidAPI provider answered.
   */
  private _normalizeResponse(category: string, raw: unknown, reqParams: Record<string, string> = {}): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const d = raw as Record<string, unknown>;

    switch (category) {
      case 'video_downloader': {
        // tiktok-downloader-download-tiktok-videos-without-watermark shape:
        // All fields are arrays — video[0], cover[0], description[0], author[0]
        if (Array.isArray(d.video) && d.video.length > 0) {
          const first = <T>(arr: unknown): T | string =>
            Array.isArray(arr) && arr.length > 0 ? (arr[0] as T) : '';
          return {
            videoUrl: first<string>(d.video),
            thumbnailUrl: first<string>(d.cover || d.dynamic_cover),
            title: first<string>(d.description) || 'TikTok Video',
            author: first<string>(d.author),
            musicUrl: first<string>(d.music),
            rawProvider: 'tiktok-downloader-no-wm',
          };
        }
        // TikTok Scraper 7: { data: { play, wmplay, hdplay, title, author: { nickname } } }
        if (d.data && typeof d.data === 'object') {
          const data = d.data as Record<string, unknown>;
          const author = typeof data.author === 'object' && data.author !== null
            ? (data.author as Record<string, unknown>).nickname as string
            : String(data.author || '');
          return {
            videoUrl: (data.play || data.hdplay || data.wmplay || '') as string,
            thumbnailUrl: (data.cover || data.origin_cover || '') as string,
            title: (data.title || 'TikTok Video') as string,
            author,
            rawProvider: 'tiktok-scraper7',
          };
        }
        // social-media-downloader: { success, links: [{ link, quality, type }] }
        if (Array.isArray(d.links) && d.links.length > 0) {
          const links = d.links as Array<Record<string, string>>;
          const best = links.find(l => l.type?.includes('mp4') || l.quality === 'hd') ?? links[0];
          return {
            videoUrl: best?.link || '',
            thumbnailUrl: (d.thumbnail as string) || '',
            title: (d.title as string) || 'Video',
            author: (d.author as string) || '',
            rawProvider: 'social-media-downloader',
          };
        }
        return raw;
      }

      case 'sports': {
        // LiveScore 6: { Ts, Stages: [{ Sid, Snm, Cnm, Events: [{ Eid, Tr1, Tr2, T1:[{Nm}], T2:[{Nm}], Esd }] }] }
        if (d.Stages !== undefined) {
          const stages = Array.isArray(d.Stages) ? d.Stages as Array<Record<string,unknown>> : [];
          const matches: unknown[] = [];
          for (const stage of stages) {
            const events = Array.isArray(stage.Events) ? stage.Events as Array<Record<string,unknown>> : [];
            for (const ev of events) {
              const t1 = Array.isArray(ev.T1) ? ev.T1 as Array<Record<string,unknown>> : [];
              const t2 = Array.isArray(ev.T2) ? ev.T2 as Array<Record<string,unknown>> : [];
              matches.push({
                id: ev.Eid,
                home: t1[0]?.Nm ?? '',
                away: t2[0]?.Nm ?? '',
                homeScore: ev.Tr1 ?? null,
                awayScore: ev.Tr2 ?? null,
                status: ev.Eps ?? ev.Esd ?? '',
                competition: stage.Cnm ?? stage.Snm ?? '',
                rawProvider: 'livescore6',
              });
            }
          }
          return { matches, liveCount: stages.length };
        }
        // API-Football v3: { response: [{ fixture, league, teams, goals }] }
        if (Array.isArray(d.response)) {
          const matches = (d.response as Array<Record<string,unknown>>).map(item => {
            const fix = (item.fixture ?? {}) as Record<string,unknown>;
            const teams = (item.teams ?? {}) as Record<string,Record<string,unknown>>;
            const goals = (item.goals ?? {}) as Record<string,unknown>;
            const league = (item.league ?? {}) as Record<string,unknown>;
            return {
              id: fix.id, home: teams.home?.name, away: teams.away?.name,
              homeScore: goals.home, awayScore: goals.away,
              status: (fix.status as Record<string,unknown>)?.short,
              competition: league.name, rawProvider: 'api-football',
            };
          });
          return { matches, liveCount: matches.length };
        }
        return raw;
      }

      case 'weather': {
        // Foreca: { current: { symbol, symbolPhrase, temperature, feelsLikeTemp, windSpeed } }
        if (d.current && !d.location && !(d.current as Record<string,unknown>).temp_c) {
          const cur = d.current as Record<string, unknown>;
          return {
            city: reqParams.city || reqParams.q || 'Accra',
            temp: cur.temperature,
            feels_like: cur.feelsLikeTemp,
            humidity: cur.relHumidity,
            description: cur.symbolPhrase,
            icon: null,
            wind_speed: cur.windSpeed,
            rawProvider: 'foreca-weather',
          };
        }
        // OpenWeatherMap: { name, main: { temp, humidity }, weather: [{ description, icon }], wind: { speed } }
        // WeatherAPI: { location: { name }, current: { temp_c, condition: { text, icon } } }
        if (d.main) {
          const main = d.main as Record<string, unknown>;
          const weatherArr = Array.isArray(d.weather) ? d.weather as Array<Record<string,unknown>> : [];
          return {
            city: d.name, temp: main.temp, feels_like: main.feels_like,
            humidity: main.humidity, description: weatherArr[0]?.description,
            icon: weatherArr[0]?.icon ? `https://openweathermap.org/img/wn/${weatherArr[0].icon}@2x.png` : null,
            wind_speed: (d.wind as Record<string,unknown>)?.speed,
          };
        }
        if (d.current && d.location) {
          const cur = d.current as Record<string, unknown>;
          const loc = d.location as Record<string, unknown>;
          const cond = cur.condition as Record<string, unknown> | undefined;
          return {
            city: loc.name, temp: cur.temp_c, feels_like: cur.feelslike_c,
            humidity: cur.humidity, description: cond?.text,
            icon: cond?.icon, wind_speed: cur.wind_kph,
          };
        }
        return raw;
      }

      default:
        return raw;
    }
  }

  /**
   * Run a post-build API verification for a project.
   * Returns whether all configured APIs are responding.
   */
  async verifyProjectApis(projectId: string): Promise<{
    passed: boolean;
    results: Array<{ category: string; ok: boolean; error?: string }>;
  }> {
    const config = await getProjectConfig(projectId);
    if (!config || config.apis.length === 0) return { passed: true, results: [] };

    const results: Array<{ category: string; ok: boolean; error?: string }> = [];

    for (const api of config.apis) {
      if (api.status === 'failed' || !api.rapidApiHost) {
        results.push({ category: api.category, ok: false, error: 'No working provider' });
        continue;
      }

      const proxyResult = await this.proxyCall({
        projectId,
        category: api.category,
        params: this._testParamsForCategory(api.category),
      });

      results.push({
        category: api.category,
        ok: proxyResult.ok,
        error: proxyResult.error,
      });

      await updateApiStatus(projectId, api.category, {
        status: proxyResult.ok ? 'working' : 'failed',
        errorMessage: proxyResult.error,
      }).catch(() => {});
    }

    return { passed: results.every(r => r.ok), results };
  }

  /** Get full project API config. */
  async getProjectConfig(projectId: string): Promise<ProjectApiConfig | null> {
    return getProjectConfig(projectId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _categoryToUrl(
    category: string,
    host: string,
    params: Record<string, string>,
  ): { url: string; params?: Record<string, string> } | null {
    switch (category) {
      case 'video_downloader': {
        const videoUrl = params.url || '';
        if (host.includes('tiktok-downloader-download-tiktok-videos-without-watermark')) {
          return { url: `https://${host}/index`, params: { url: videoUrl, hd: '1' } };
        }
        if (host.includes('tiktok-scraper7')) {
          return { url: `https://${host}/video/info`, params: { url: videoUrl } };
        }
        if (host.includes('social-media-video-downloader')) {
          return { url: `https://${host}/smvd/get/all`, params: { url: videoUrl } };
        }
        // Generic fallback
        return { url: `https://${host}/index`, params: { url: videoUrl, hd: '1' } };
      }
      case 'weather': {
        // foreca-weather uses numeric location IDs, not city names
        if (host.includes('foreca-weather')) {
          const locId = params.locationId || '102339354'; // default: Accra, Ghana
          return { url: `https://${host}/current/${locId}` };
        }
        // weatherapi-com uses /v1/current.json?q=city
        if (host.includes('weatherapi-com')) {
          return { url: `https://${host}/v1/current.json`, params: { q: params.city || params.q || 'Accra' } };
        }
        // community-open-weather-map and generic OWM hosts
        return { url: `https://${host}/weather`, params: { q: params.city || params.q || 'Accra', units: params.units || 'metric' } };
      }

      case 'music': {
        // deezer uses /search?q=
        if (host.includes('deezer')) {
          return { url: `https://${host}/search`, params: { q: params.q || params.query || 'top hits' } };
        }
        // shazam.p.rapidapi.com uses /search?term=
        if (host.includes('shazam.p.rapidapi')) {
          return { url: `https://${host}/search`, params: { term: params.q || params.query || 'top hits', locale: 'en-US', offset: '0', limit: '10' } };
        }
        // shazam-core uses /v1/search/multi
        return { url: `https://${host}/v1/search/multi`, params: { search_type: 'SONGS_ARTISTS', query: params.q || params.query || 'top hits' } };
      }

      case 'sports': {
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        // LiveScore 6 — primary subscribed sports API
        if (host.includes('livescore6')) {
          if (params.date) {
            // list-by-date for specific date
            const d = params.date.replace(/-/g, ''); // accept YYYY-MM-DD or YYYYMMDD
            return { url: `https://${host}/matches/v2/list-by-date`, params: { Category: 'soccer', Date: d, Timezone: '0' } };
          }
          // live scores by default
          return { url: `https://${host}/matches/v2/list-live`, params: { Category: 'soccer', Timezone: '0' } };
        }
        // API-Football v3
        if (host.includes('api-football-v1')) {
          return { url: `https://${host}/v3/fixtures`, params: { league: params.league || '39', season: params.season || '2025', date: params.date || new Date().toISOString().split('T')[0] } };
        }
        // SofaScore
        if (host.includes('sofascores')) {
          return { url: `https://${host}/v1/events/schedule/sport`, params: { sport_id: '1', date: params.date || new Date().toISOString().split('T')[0] } };
        }
        // Generic fallback — try livescore6 pattern
        return { url: `https://${host}/matches/v2/list-live`, params: { Category: 'soccer', Timezone: '0' } };
      }

      case 'finance': {
        // exchange-rate-api uses /rapid/latest/{base}
        if (host.includes('exchange-rate-api')) {
          return { url: `https://${host}/rapid/latest/${params.from || 'USD'}` };
        }
        // coinranking uses /coins
        if (host.includes('coinranking')) {
          return { url: `https://${host}/coins`, params: { limit: params.limit || '20' } };
        }
        // currency-exchange uses /exchange?from=&to=&q=
        return { url: `https://${host}/exchange`, params: { from: params.from || 'USD', to: params.to || 'GHS', q: '1.0' } };
      }

      case 'news': {
        const q = params.q || 'world news';
        // newscatcher uses /v2/latest_headlines or /v2/search
        if (host.includes('newscatcher')) {
          return { url: `https://${host}/v2/search`, params: { q, lang: 'en', sort_by: 'relevancy', page_size: params.count || '10', page: '1' } };
        }
        // bing-news uses /news/search
        return { url: `https://${host}/news/search`, params: { q, mkt: 'en-US', count: params.count || '10', safeSearch: 'Off', textFormat: 'Raw' } };
      }
      default:
        return null;
    }
  }

  private _testParamsForCategory(category: string): Record<string, string> {
    const defaults: Record<string, Record<string, string>> = {
      weather: { city: 'London', units: 'metric' },
      music: { q: 'one dance' },
      sports: { league: '39', season: '2024' },
      finance: { from: 'USD', to: 'GHS' },
      news: { q: 'technology' },
    };
    return defaults[category] ?? {};
  }

  private _buildForwardedKeys(): Array<{ envVar: string; value: string; comment: string }> {
    return FORWARD_ENV_VARS
      .map(({ envVar, comment }) => ({ envVar, value: getKey(envVar), comment }))
      .filter(k => k.value.length > 0);
  }

  private _buildPromptInstructions(
    resolved: ApiPlan['resolved'],
    missing: string[],
    platformPort: number,
    projectId: string,
  ): string {
    if (resolved.length === 0 && missing.length === 0) return '';

    const lines: string[] = [
      '',
      '═══════════════════════════════════════════════════════════',
      'DWOMOH API MANAGER — PLATFORM CONFIG (AUTO-INJECTED)',
      '═══════════════════════════════════════════════════════════',
      '',
      'Generated apps use the DWOMOH platform as a secure API proxy.',
      `Platform URL: http://localhost:${platformPort}`,
      `Project ID:   ${projectId}`,
      '',
      'ROUTING RULE — ALL external API calls must follow this pattern:',
      '  1. Frontend component → /api/integrations/[category]  (local Next.js route)',
      '  2. Local route        → DWOMOH_PLATFORM_URL/api/api-manager/proxy  (platform proxy)',
      '  3. Platform proxy     → External API (RAPIDAPI_KEY stays on platform only)',
      '',
      'Generated route template:',
      '  const res = await fetch(`${DWOMOH_PLATFORM_URL}/api/api-manager/proxy`, {',
      '    method: "POST",',
      '    headers: { "Content-Type": "application/json" },',
      '    body: JSON.stringify({ projectId: process.env.DWOMOH_PROJECT_ID, category: "weather", params: { city } })',
      '  });',
      '',
    ];

    if (resolved.length > 0) {
      lines.push('CONFIGURED PROVIDERS — generate routes for these categories:');
      for (const r of resolved) {
        lines.push(`  ✅ ${r.category} → ${r.providerName} (${r.host})`);
      }
      lines.push('');
    }

    if (missing.length > 0) {
      lines.push('UNCONFIGURED CATEGORIES — use free public APIs as fallback (NOT mock data):');
      lines.push('');
      for (const cat of missing) {
        const fallback = FREE_API_FALLBACKS[cat];
        if (fallback) {
          lines.push(`  ${cat.toUpperCase()} — use this free API (no key needed):`);
          lines.push(`  ${fallback.description}`);
          lines.push(`  Route file: ${fallback.routeFile}`);
          lines.push(`  Example: ${fallback.example}`);
          lines.push('');
        } else {
          lines.push(`  ⚠️ ${cat}: No free fallback available. Show a clear "Configure API" UI panel`);
          lines.push(`         with a message: "Connect your ${cat} API provider to enable this feature."`);
          lines.push(`         NEVER return fake/mock data. NEVER hard-code fake values.`);
          lines.push('');
        }
      }
    }

    lines.push('═══════════════════════════════════════════════════════════');
    return lines.join('\n');
  }
}

export const apiManager = ApiManager.instance();

// ── Free public API fallbacks ─────────────────────────────────────────────────
// Used when RAPIDAPI_KEY is not configured. These APIs are free, require no key,
// and return real live data. Generated apps use them automatically so every app
// works out of the box without manual credential setup.

interface FreeFallback {
  description: string;
  routeFile: string;
  example: string;
  route: string; // content to write to the route file
}

export const FREE_API_FALLBACKS: Record<string, FreeFallback> = {
  weather: {
    description: 'Open-Meteo (https://open-meteo.com) — completely free, no API key, CORS-friendly, real live data.',
    routeFile: 'app/api/integrations/weather/route.ts',
    example: 'GET https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current_weather=true',
    route: `import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Open-Meteo: free weather API — no API key required
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get('city') || searchParams.get('q') || 'London';

  try {
    // 1. Geocode city name → lat/lon
    const geoRes = await fetch(
      \`\${GEO_URL}?name=\${encodeURIComponent(city)}&count=1&language=en&format=json\`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!geoRes.ok) return NextResponse.json({ error: 'Geocoding failed' }, { status: 502 });
    const geoData = await geoRes.json();
    const loc = geoData.results?.[0];
    if (!loc) return NextResponse.json({ error: \`City not found: \${city}\` }, { status: 404 });

    // 2. Fetch current weather
    const params = new URLSearchParams({
      latitude: String(loc.latitude),
      longitude: String(loc.longitude),
      current_weather: 'true',
      hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      forecast_days: '1',
    });
    const weatherRes = await fetch(\`\${WEATHER_URL}?\${params}\`, { signal: AbortSignal.timeout(8000) });
    if (!weatherRes.ok) return NextResponse.json({ error: 'Weather fetch failed' }, { status: 502 });
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    // WMO weather interpretation codes → description
    const WMO: Record<number, string> = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
      55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
      71: 'Light snow', 73: 'Moderate snow', 75: 'Heavy snow', 80: 'Rain showers',
      81: 'Moderate showers', 82: 'Violent showers', 95: 'Thunderstorm',
    };

    return NextResponse.json({
      city: loc.name,
      country: loc.country_code,
      latitude: loc.latitude,
      longitude: loc.longitude,
      temperature: current.temperature,
      feels_like: current.temperature,
      humidity: weatherData.hourly?.relative_humidity_2m?.[0] ?? null,
      wind_speed: current.windspeed,
      description: WMO[current.weathercode] || 'Unknown',
      weathercode: current.weathercode,
      is_day: current.is_day === 1,
      precipitation_probability: weatherData.hourly?.precipitation_probability?.[0] ?? null,
      provider: 'open-meteo',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Weather service unavailable' },
      { status: 503 }
    );
  }
}`,
  },

  news: {
    description: 'GNews/HN Algolia — GNews with key (preferred) or Hacker News Algolia (free, no key, real headlines).',
    routeFile: 'app/api/integrations/news/route.ts',
    example: 'GET /api/integrations/news?q=technology',
    route: `import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || searchParams.get('query') || 'technology';
  const gNewsKey = process.env.GNEWS_API_KEY || '';

  try {
    if (gNewsKey) {
      // GNews with API key — full category + language support
      const res = await fetch(
        \`https://gnews.io/api/v4/search?q=\${encodeURIComponent(q)}&lang=en&max=10&apikey=\${gNewsKey}\`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        const articles = (data.articles ?? []).map((a: Record<string,unknown>) => ({
          title: a.title,
          description: a.description,
          url: a.url,
          source: (a.source as Record<string,string>)?.name ?? 'GNews',
          publishedAt: a.publishedAt,
          imageUrl: a.image ?? null,
        }));
        return NextResponse.json({ articles, total: articles.length, query: q, provider: 'gnews' });
      }
    }

    // Free fallback: Hacker News via Algolia — no key required, real-time top stories
    const hnRes = await fetch(
      \`https://hn.algolia.com/api/v1/search?tags=front_page&query=\${encodeURIComponent(q)}&hitsPerPage=10\`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!hnRes.ok) return NextResponse.json({ error: 'News fetch failed' }, { status: 502 });
    const hnData = await hnRes.json();
    const articles = (hnData.hits ?? []).map((h: Record<string,unknown>) => ({
      title: h.title,
      description: null,
      url: h.url ?? \`https://news.ycombinator.com/item?id=\${h.objectID}\`,
      source: 'Hacker News',
      publishedAt: h.created_at,
      imageUrl: null,
    }));
    return NextResponse.json({ articles, total: articles.length, query: q, provider: 'hacker-news' });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'News unavailable' }, { status: 503 });
  }
}`,
  },

  finance: {
    description: 'ExchangeRate-API (https://api.exchangerate-api.com) — free tier, no key, real FX rates.',
    routeFile: 'app/api/integrations/finance/route.ts',
    example: 'GET https://api.exchangerate-api.com/v4/latest/USD',
    route: `import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const from = (searchParams.get('from') || 'USD').toUpperCase();
  const to = (searchParams.get('to') || 'GHS').toUpperCase();
  const amount = parseFloat(searchParams.get('amount') || '1');

  try {
    const res = await fetch(
      \`https://api.exchangerate-api.com/v4/latest/\${from}\`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return NextResponse.json({ error: 'Exchange rate fetch failed' }, { status: 502 });
    const data = await res.json();
    const rate = data.rates?.[to];
    if (!rate) return NextResponse.json({ error: \`Currency \${to} not found\` }, { status: 404 });

    return NextResponse.json({
      from, to, rate,
      amount,
      converted: +(amount * rate).toFixed(4),
      date: data.date,
      provider: 'exchangerate-api',
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Finance service unavailable' }, { status: 503 });
  }
}`,
  },

  sports: {
    description: 'ESPN public API — no API key required, real live scores and fixtures for all major sports.',
    routeFile: 'app/api/integrations/sports/route.ts',
    example: 'GET /api/integrations/sports?sport=soccer&league=eng.1',
    route: `import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// ESPN public API — no key required, real live sports data
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// League slugs: soccer (English leagues), American sports, etc.
const LEAGUE_MAP: Record<string, string> = {
  // Soccer
  soccer: 'soccer/eng.1',          // Premier League (default)
  'soccer/eng.1': 'soccer/eng.1',
  'soccer/esp.1': 'soccer/esp.1',  // La Liga
  'soccer/ger.1': 'soccer/ger.1',  // Bundesliga
  'soccer/ita.1': 'soccer/ita.1',  // Serie A
  'soccer/usa.1': 'soccer/usa.1',  // MLS
  football: 'football/nfl',
  nfl: 'football/nfl',
  basketball: 'basketball/nba',
  nba: 'basketball/nba',
  baseball: 'baseball/mlb',
  mlb: 'baseball/mlb',
  hockey: 'hockey/nhl',
  nhl: 'hockey/nhl',
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sportParam = (searchParams.get('sport') || 'soccer').toLowerCase();
  const leagueParam = searchParams.get('league') || '';

  // Resolve league path: explicit league param overrides sport param
  const leagueKey = leagueParam ? (LEAGUE_MAP[leagueParam] ?? \`soccer/\${leagueParam}\`) : (LEAGUE_MAP[sportParam] ?? 'soccer/eng.1');

  try {
    const res = await fetch(
      \`\${ESPN_BASE}/\${leagueKey}/scoreboard\`,
      {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      }
    );
    if (!res.ok) return NextResponse.json({ error: \`Sports data unavailable (HTTP \${res.status})\` }, { status: 502 });
    const data = await res.json();

    const events = (data.events ?? []).map((e: Record<string, unknown>) => {
      const comp = (e.competitions as Record<string, unknown>[])?.[0] ?? {};
      const competitors = (comp.competitors as Record<string, unknown>[]) ?? [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      const status = (comp.status as Record<string, unknown>) ?? {};
      const statusType = (status.type as Record<string, unknown>) ?? {};
      return {
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        home: (home?.team as Record<string,string>)?.displayName ?? '',
        homeScore: home?.score ?? null,
        homeLogoUrl: (home?.team as Record<string,string>)?.logo ?? null,
        away: (away?.team as Record<string,string>)?.displayName ?? '',
        awayScore: away?.score ?? null,
        awayLogoUrl: (away?.team as Record<string,string>)?.logo ?? null,
        status: statusType.description ?? 'Scheduled',
        statusState: statusType.state ?? 'pre',   // 'pre' | 'in' | 'post'
        isLive: statusType.state === 'in',
        date: e.date,
        venue: (comp.venue as Record<string,string>)?.fullName ?? null,
        provider: 'espn-public',
      };
    });

    const leagueName = (data.leagues as Record<string,string>[])?.[0]?.name ?? leagueKey;
    const seasonYear = (data.season as Record<string,unknown>)?.year ?? null;

    return NextResponse.json({
      sport: sportParam,
      league: leagueName,
      season: seasonYear,
      events,
      total: events.length,
      liveCount: events.filter((e: Record<string, unknown>) => e.isLive).length,
      provider: 'espn-public',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sports service unavailable' },
      { status: 503 }
    );
  }
}`,
  },
};
