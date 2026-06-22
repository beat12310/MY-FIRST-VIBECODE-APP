/**
 * DWOMOH Vibe Code — Platform API Catalog
 *
 * Each entry describes one RapidAPI provider for a given category.
 * Entries are ordered: first entry = preferred provider.
 * The connector tries each in order and uses the first one that passes validation.
 */

export type ApiCategory =
  | 'video_downloader'
  | 'music'
  | 'weather'
  | 'sports'
  | 'finance'
  | 'news'
  | 'ai_tools'
  | 'maps'
  | 'translate';

export type ApiStatus = 'working' | 'failed' | 'needs_setup' | 'untested';

export interface ApiEntry {
  id: string;
  name: string;
  category: ApiCategory;
  useCase: string;
  rapidApiHost: string;
  testEndpoint: string;
  testParams?: Record<string, string>;
  testMethod?: 'GET' | 'POST';
  testBody?: Record<string, unknown>;
  /** Returns true if the response shape looks valid for this API */
  responseValidator: (data: unknown) => boolean;
  /** Extracts the most relevant field from a test response for display */
  responsePreview?: (data: unknown) => string;
  status: ApiStatus;
  usageCount: number;
  lastTestedAt?: string;
  lastError?: string;
  /** Prompt injection snippet: how the generated app should call this API */
  promptHint: string;
}

// ─── Validators ───────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasKey = (v: unknown, key: string): boolean => isObj(v) && key in v;

const hasAnyKey = (v: unknown, ...keys: string[]): boolean => keys.some(k => hasKey(v, k));

// ─── Catalog ──────────────────────────────────────────────────────────────────

export const API_CATALOG: ApiEntry[] = [

  // ── Video Downloader ────────────────────────────────────────────────────────
  {
    id: 'tiktok-downloader-no-wm',
    name: 'TikTok Downloader (No Watermark)',
    category: 'video_downloader',
    useCase: 'Download TikTok videos without watermark — verified working, returns direct MP4 URLs',
    rapidApiHost: 'tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com',
    testEndpoint: 'https://tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com/index',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675', hd: '1' },
    // Response: all fields are arrays. video[0]=no-watermark mp4, cover[0]=thumbnail
    responseValidator: (d) => isObj(d) && Array.isArray((d as Record<string,unknown>).video) && ((d as Record<string,unknown[]>).video).length > 0,
    responsePreview: (d) => {
      const v = (d as Record<string,unknown[]>).video;
      return Array.isArray(v) && v.length > 0 ? `video URL: ${String(v[0]).slice(0,60)}…` : 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// TikTok Downloader — GET .../index?url={encodedTikTokUrl}&hd=1
// Response: { video: [mp4Url], cover: [thumbnailUrl], description: [title], author: [username], music: [audioUrl] }
// All values are arrays — use video[0] for the playable no-watermark MP4`,
  },

  {
    id: 'social-media-downloader',
    name: 'Social Media Video Downloader',
    category: 'video_downloader',
    useCase: 'Download videos from TikTok, Instagram, YouTube, Facebook, and Twitter',
    rapidApiHost: 'social-media-video-downloader.p.rapidapi.com',
    testEndpoint: 'https://social-media-video-downloader.p.rapidapi.com/smvd/get/all',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'links') || hasKey(d, 'success') || hasKey(d, 'data')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.links)) return `${(d.links as unknown[]).length} download link(s)`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Social media download — GET https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url={mediaUrl}
// Response: { success, links: [{ link, quality, type }] }`,
  },

  {
    id: 'ssstik-downloader',
    name: 'SSSTik — TikTok Downloader',
    category: 'video_downloader',
    useCase: 'Download TikTok and Instagram Reels without watermark',
    rapidApiHost: 'tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com',
    testEndpoint: 'https://tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com/index',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675', hd: '0' },
    responseValidator: (d) => isObj(d) && (hasAnyKey(d, 'video', 'music', 'title', 'play')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// SSSTik — GET .../index?url={tikTokUrl}&hd=0\n// Response: { video: [mp4Url], music: [audioUrl], title }`,
  },

  // ── Music / Shazam ──────────────────────────────────────────────────────────
  {
    id: 'shazam-core',
    name: 'Shazam Core',
    category: 'music',
    useCase: 'Song recognition, search, charts, and lyrics',
    rapidApiHost: 'shazam-core.p.rapidapi.com',
    testEndpoint: 'https://shazam-core.p.rapidapi.com/v1/charts/world',
    responseValidator: (d) => isObj(d) && (hasKey(d, 'tracks') || hasAnyKey(d, 'chart', 'tracks', 'items')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.tracks)) return `${d.tracks.length} tracks`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Shazam Core — GET https://shazam-core.p.rapidapi.com/v1/search/multi?search_type=SONGS_ARTISTS&query={query}
// Response: { tracks: { hits: [{ track: { title, subtitle, images } }] } }`,
  },

  {
    id: 'shazam',
    name: 'Shazam (Official)',
    category: 'music',
    useCase: 'Search songs, get charts, detect music',
    rapidApiHost: 'shazam.p.rapidapi.com',
    testEndpoint: 'https://shazam.p.rapidapi.com/search',
    testParams: { term: 'One Dance', locale: 'en-US', offset: '0', limit: '5' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'tracks') || hasKey(d, 'artists')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// Shazam — GET https://shazam.p.rapidapi.com/search?term={query}&locale=en-US&offset=0&limit=5
// Response: { tracks: { hits: [{ track: { title, subtitle, images, share: { href } } }] } }`,
  },

  {
    id: 'deezer',
    name: 'Deezer',
    category: 'music',
    useCase: 'Music search, artist info, albums, playlists',
    rapidApiHost: 'deezerdevs-deezer.p.rapidapi.com',
    testEndpoint: 'https://deezerdevs-deezer.p.rapidapi.com/search',
    testParams: { q: 'drake' },
    responseValidator: (d) => isObj(d) && hasKey(d, 'data') && Array.isArray((d as Record<string,unknown>).data),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.data)) return `${d.data.length} results`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Deezer — GET https://deezerdevs-deezer.p.rapidapi.com/search?q={query}
// Response: { data: [{ id, title, artist: { name }, album: { title, cover } }] }`,
  },

  // ── Weather ─────────────────────────────────────────────────────────────────
  {
    id: 'open-weather-map',
    name: 'OpenWeatherMap',
    category: 'weather',
    useCase: 'Current weather, 5-day forecast, air quality by city or coordinates',
    rapidApiHost: 'community-open-weather-map.p.rapidapi.com',
    testEndpoint: 'https://community-open-weather-map.p.rapidapi.com/weather',
    testParams: { q: 'Accra,GH', units: 'metric', lang: 'en' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'main') || hasKey(d, 'weather') || hasKey(d, 'name')),
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.main)) return `${d.name} — ${(d.main as Record<string,unknown>).temp}°C`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// OpenWeatherMap — GET https://community-open-weather-map.p.rapidapi.com/weather?q={city}&units=metric
// Response: { name, main: { temp, feels_like, humidity }, weather: [{ description, icon }], wind: { speed } }`,
  },

  {
    id: 'weatherapi',
    name: 'WeatherAPI.com',
    category: 'weather',
    useCase: 'Real-time weather, 14-day forecast, astronomy data',
    rapidApiHost: 'weatherapi-com.p.rapidapi.com',
    testEndpoint: 'https://weatherapi-com.p.rapidapi.com/v1/current.json',
    testParams: { q: 'Accra' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'current') || hasKey(d, 'location')),
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.current)) return `temp: ${(d.current as Record<string,unknown>).temp_c}°C`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// WeatherAPI — GET https://weatherapi-com.p.rapidapi.com/v1/current.json?q={city}
// Response: { location: { name, country }, current: { temp_c, feelslike_c, humidity, wind_kph, condition: { text, icon } } }`,
  },

  {
    id: 'foreca-weather',
    name: 'Foreca Weather',
    category: 'weather',
    useCase: 'Hourly and daily forecasts with detailed weather data',
    rapidApiHost: 'foreca-weather.p.rapidapi.com',
    testEndpoint: 'https://foreca-weather.p.rapidapi.com/current/102339354',
    responseValidator: (d) => isObj(d) && (hasKey(d, 'current') || hasAnyKey(d, 'temp', 'feelsLikeTemp')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// Foreca — GET https://foreca-weather.p.rapidapi.com/current/{locationId}`,
  },

  // ── Sports ──────────────────────────────────────────────────────────────────
  {
    id: 'livescore6',
    name: 'LiveScore 6 (Football)',
    category: 'sports',
    useCase: 'Live football scores, fixtures, standings — World Cup, Premier League, Champions League',
    rapidApiHost: 'livescore6.p.rapidapi.com',
    testEndpoint: 'https://livescore6.p.rapidapi.com/matches/v2/list-live',
    testParams: { Category: 'soccer', Timezone: '0' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'Stages') || hasKey(d, 'Ts') || hasKey(d, 'data')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.Stages)) return `${d.Stages.length} live stage(s)`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// LiveScore 6 — GET https://livescore6.p.rapidapi.com/matches/v2/list-live?Category=soccer&Timezone=0
// Response: { Ts, Stages: [{ Sid, Snm (stage name), Cnm (competition), Csnm, Events: [{ Eid, Tr1 (home score), Tr2 (away score), T1: [{Nm}], T2: [{Nm}] }] }] }
// For fixtures by date: GET /matches/v2/list-by-date?Category=soccer&Date=YYYYMMDD&Timezone=0`,
  },

  {
    id: 'api-football',
    name: 'API-Football (Football v3)',
    category: 'sports',
    useCase: 'Live scores, fixtures, standings, player stats — 900+ leagues',
    rapidApiHost: 'api-football-v1.p.rapidapi.com',
    testEndpoint: 'https://api-football-v1.p.rapidapi.com/v3/leagues',
    testParams: { country: 'Ghana' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'response') || hasKey(d, 'results')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.response)) return `${d.response.length} leagues`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// API-Football — GET https://api-football-v1.p.rapidapi.com/v3/fixtures?date={YYYY-MM-DD}&league={leagueId}&season={year}
// Response: { response: [{ fixture: { id, date, status }, league: { name }, teams: { home, away }, goals: { home, away } }] }`,
  },

  {
    id: 'sofascore',
    name: 'SofaScore',
    category: 'sports',
    useCase: 'Live scores, match events, player ratings, lineups',
    rapidApiHost: 'sofascores.p.rapidapi.com',
    testEndpoint: 'https://sofascores.p.rapidapi.com/v1/category/list',
    testParams: { sport_id: '1' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'categories') || hasKey(d, 'data') || hasKey(d, 'ok')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// SofaScore — GET https://sofascores.p.rapidapi.com/v1/events/schedule/sport?sport_id=1&date={YYYY-MM-DD}`,
  },

  // ── Finance / Currency ──────────────────────────────────────────────────────
  {
    id: 'currency-exchange',
    name: 'Currency Exchange',
    category: 'finance',
    useCase: 'Real-time currency exchange rates for 170+ currencies',
    rapidApiHost: 'currency-exchange.p.rapidapi.com',
    testEndpoint: 'https://currency-exchange.p.rapidapi.com/exchange',
    testParams: { from: 'USD', to: 'GHS', q: '1.0' },
    responseValidator: (d) => typeof d === 'number' || (isObj(d) && hasAnyKey(d, 'result', 'rate', 'rates')),
    responsePreview: (d) => typeof d === 'number' ? `1 USD = ${d} GHS` : 'rate returned',
    status: 'untested',
    usageCount: 0,
    promptHint: `// Currency Exchange — GET https://currency-exchange.p.rapidapi.com/exchange?from={from}&to={to}&q=1
// Response: number (the exchange rate)`,
  },

  {
    id: 'exchange-rate-api',
    name: 'Exchange Rate API',
    category: 'finance',
    useCase: 'Exchange rates with historical data support',
    rapidApiHost: 'exchange-rate-api.p.rapidapi.com',
    testEndpoint: 'https://exchange-rate-api.p.rapidapi.com/rapid/latest/USD',
    responseValidator: (d) => isObj(d) && (hasKey(d, 'rates') || hasKey(d, 'conversion_rates')),
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.rates)) return `USD base, ${Object.keys(d.rates).length} currencies`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Exchange Rate API — GET https://exchange-rate-api.p.rapidapi.com/rapid/latest/{base}
// Response: { base_code, rates: { GHS: 12.5, EUR: 0.92, ... } }`,
  },

  {
    id: 'coinranking',
    name: 'Coinranking (Crypto)',
    category: 'finance',
    useCase: 'Cryptocurrency prices, market cap, and historical data',
    rapidApiHost: 'coinranking1.p.rapidapi.com',
    testEndpoint: 'https://coinranking1.p.rapidapi.com/coins',
    testParams: { limit: '5' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'data') && isObj((d as Record<string,unknown>).data) && hasKey((d as Record<string,unknown>).data, 'coins')),
    responsePreview: (d) => {
      const coins = (d as Record<string, Record<string, unknown>>)?.data?.coins;
      if (Array.isArray(coins)) return `${coins.length} coins`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Coinranking — GET https://coinranking1.p.rapidapi.com/coins?limit=20
// Response: { data: { coins: [{ name, symbol, price, change, iconUrl }] } }`,
  },

  // ── News ─────────────────────────────────────────────────────────────────────
  {
    id: 'bing-news',
    name: 'Bing News Search',
    category: 'news',
    useCase: 'Real-time news articles from around the web',
    rapidApiHost: 'bing-news-search1.p.rapidapi.com',
    testEndpoint: 'https://bing-news-search1.p.rapidapi.com/news/search',
    testParams: { q: 'technology', mkt: 'en-US', safeSearch: 'Off', textFormat: 'Raw', freshness: 'Day', count: '5' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'value') && Array.isArray((d as Record<string,unknown>).value)),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.value)) return `${d.value.length} articles`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Bing News — GET https://bing-news-search1.p.rapidapi.com/news/search?q={query}&mkt=en-US&count=10
// Response: { value: [{ name, description, url, image, datePublished, provider: [{ name }] }] }`,
  },

  {
    id: 'newscatcher',
    name: 'NewsCatcher',
    category: 'news',
    useCase: 'News from 60,000+ sources — headlines, keyword search, trending',
    rapidApiHost: 'newscatcher.p.rapidapi.com',
    testEndpoint: 'https://newscatcher.p.rapidapi.com/v2/latest_headlines',
    testParams: { lang: 'en', country: 'US', page_size: '5', page: '1' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'articles') || hasKey(d, 'news')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.articles)) return `${d.articles.length} articles`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// NewsCatcher — GET https://newscatcher.p.rapidapi.com/v2/search?q={query}&lang=en&sort_by=relevancy
// Response: { articles: [{ title, summary, link, published_date, clean_url, media }] }`,
  },

  {
    id: 'currents-news',
    name: 'Currents API — Live News',
    category: 'news',
    useCase: 'Latest news articles from global sources with category filtering',
    rapidApiHost: 'currentsapi.services',
    testEndpoint: 'https://currentsapi.services/api/v1/latest-news',
    testParams: { language: 'en', country: 'GH' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'news') || hasKey(d, 'status')),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.news)) return `${d.news.length} articles`;
      return 'response ok';
    },
    status: 'untested',
    usageCount: 0,
    promptHint: `// Currents API — GET https://currentsapi.services/api/v1/latest-news?language=en
// Response: { news: [{ title, description, url, image, published, category }] }`,
  },

  // ── AI Tools ─────────────────────────────────────────────────────────────────
  {
    id: 'chatgpt-api',
    name: 'ChatGPT (OpenAI)',
    category: 'ai_tools',
    useCase: 'Text generation, summarization, Q&A, translation',
    rapidApiHost: 'chatgpt-42.p.rapidapi.com',
    testEndpoint: 'https://chatgpt-42.p.rapidapi.com/conversationgpt4',
    testMethod: 'POST',
    testBody: { messages: [{ role: 'user', content: 'Say hello' }], system_prompt: '', temperature: 0.9, top_k: 5, top_p: 0.9, max_tokens: 256 },
    responseValidator: (d) => isObj(d) && (hasAnyKey(d, 'result', 'choices', 'message', 'content')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// ChatGPT via RapidAPI — POST https://chatgpt-42.p.rapidapi.com/conversationgpt4
// Body: { messages: [{ role, content }], temperature: 0.9, max_tokens: 256 }
// Response: { result: string }`,
  },

  {
    id: 'text-summarizer',
    name: 'Text Summarizer',
    category: 'ai_tools',
    useCase: 'Summarize long articles and documents',
    rapidApiHost: 'text-summarizer-api.p.rapidapi.com',
    testEndpoint: 'https://text-summarizer-api.p.rapidapi.com/summarize-text',
    testMethod: 'POST',
    testBody: { text: 'Artificial intelligence is transforming many industries including healthcare, finance, and education.', percent: 50 },
    responseValidator: (d) => isObj(d) && (hasAnyKey(d, 'result', 'summary', 'data')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// Text Summarizer — POST https://text-summarizer-api.p.rapidapi.com/summarize-text
// Body: { text: string, percent: 50 }`,
  },

  // ── Maps / Location ──────────────────────────────────────────────────────────
  {
    id: 'geocoding-api',
    name: 'Geocoding API',
    category: 'maps',
    useCase: 'Convert addresses to coordinates and reverse geocode',
    rapidApiHost: 'geocoding-api.p.rapidapi.com',
    testEndpoint: 'https://geocoding-api.p.rapidapi.com/v1/geocode',
    testParams: { address: 'Accra, Ghana' },
    responseValidator: (d) => isObj(d) && (hasKey(d, 'results') || hasAnyKey(d, 'lat', 'lng', 'latitude', 'longitude')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// Geocoding — GET https://geocoding-api.p.rapidapi.com/v1/geocode?address={address}`,
  },

  // ── Translate ─────────────────────────────────────────────────────────────────
  {
    id: 'google-translate',
    name: 'Google Translate v3',
    category: 'translate',
    useCase: 'Translate text between 100+ languages',
    rapidApiHost: 'google-translate113.p.rapidapi.com',
    testEndpoint: 'https://google-translate113.p.rapidapi.com/api/v1/translator/text',
    testMethod: 'POST',
    testBody: { from: 'en', to: 'fr', text: 'Hello World' },
    responseValidator: (d) => isObj(d) && (hasAnyKey(d, 'trans', 'result', 'translation', 'text')),
    status: 'untested',
    usageCount: 0,
    promptHint: `// Google Translate — POST https://google-translate113.p.rapidapi.com/api/v1/translator/text
// Body: { from: 'en', to: 'fr', text: 'Hello World' }
// Response: { trans: 'Bonjour le monde' }`,
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** All providers for a given category, in preference order. */
export function getProviders(category: ApiCategory): ApiEntry[] {
  return API_CATALOG.filter(e => e.category === category);
}

/** All categories present in the catalog. */
export function allCategories(): ApiCategory[] {
  return [...new Set(API_CATALOG.map(e => e.category))];
}

/** Find a catalog entry by id. */
export function getEntryById(id: string): ApiEntry | undefined {
  return API_CATALOG.find(e => e.id === id);
}

/** Mark an entry's test result (mutates in-place for the process lifetime). */
export function updateEntryStatus(id: string, result: { status: ApiStatus; error?: string }): void {
  const entry = getEntryById(id);
  if (!entry) return;
  entry.status = result.status;
  entry.lastTestedAt = new Date().toISOString();
  entry.lastError = result.error;
}
