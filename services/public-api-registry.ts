/**
 * DWOMOH Approved Public API Registry
 *
 * Free, no-key, production-quality public APIs used as Tier 3 fallback
 * when AWS and RapidAPI don't cover a category.
 *
 * Each entry is vetted: stable, rate-limit friendly, no signup required.
 */

export interface PublicApiEntry {
  id: string;
  name: string;
  baseUrl: string;
  categories: string[];
  keywords: string[];
  description: string;
  /** Build the fetch URL for a given set of params */
  buildUrl: (params: Record<string, string>) => string;
  /** Example params for testing */
  testParams: Record<string, string>;
  /** Validate the response is real data */
  responseValidator: (data: unknown) => boolean;
  /** Extract a preview string */
  responsePreview?: (data: unknown) => string;
  /** Normalize response to a consistent shape */
  normalize?: (data: unknown, params: Record<string, string>) => unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const PUBLIC_API_REGISTRY: PublicApiEntry[] = [

  // ── Weather ──────────────────────────────────────────────────────────────────
  {
    id: 'open-meteo',
    name: 'Open-Meteo',
    baseUrl: 'https://api.open-meteo.com',
    categories: ['weather', 'forecast', 'climate'],
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'wind', 'humidity', 'climate'],
    description: 'Free weather API — current conditions and 7-day forecast. No key required.',
    buildUrl: (p) => {
      const city = p.city || p.q || 'Accra';
      const lat = p.lat || '5.6037';
      const lon = p.lon || '-0.1870';
      return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7`;
    },
    testParams: { city: 'Accra', lat: '5.6037', lon: '-0.1870' },
    responseValidator: (d) => isObj(d) && 'current' in d,
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.current)) {
        return `${(d.current as Record<string,unknown>).temperature_2m}°C`;
      }
      return 'weather data';
    },
    normalize: (d, _p) => {
      if (!isObj(d) || !isObj(d.current)) return d;
      const cur = d.current as Record<string, unknown>;
      const wmoMap: Record<number, string> = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
        61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain',
        71: 'Light snow', 73: 'Moderate snow', 80: 'Rain showers', 95: 'Thunderstorm',
      };
      const code = cur.weather_code as number;
      return {
        temp: cur.temperature_2m,
        humidity: cur.relative_humidity_2m,
        wind_speed: cur.wind_speed_10m,
        description: wmoMap[code] ?? `Code ${code}`,
        source: 'Open-Meteo',
      };
    },
  },

  // ── Finance / Currency ───────────────────────────────────────────────────────
  {
    id: 'exchangerate-api-free',
    name: 'ExchangeRate-API (Free)',
    baseUrl: 'https://open.er-api.com',
    categories: ['finance', 'currency', 'forex'],
    keywords: ['currency', 'exchange rate', 'forex', 'convert', 'usd', 'ghs', 'eur', 'gbp'],
    description: 'Free currency exchange rates — 161 currencies, updates daily. No key required.',
    buildUrl: (p) => `https://open.er-api.com/v6/latest/${p.from || 'USD'}`,
    testParams: { from: 'USD', to: 'GHS' },
    responseValidator: (d) => isObj(d) && 'rates' in d,
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.rates)) return `${Object.keys(d.rates).length} currencies`;
      return 'exchange rates';
    },
    normalize: (d, p) => {
      if (!isObj(d) || !isObj(d.rates)) return d;
      const rates = d.rates as Record<string, number>;
      const to = p.to || 'GHS';
      return { base: d.base_code, to, rate: rates[to], rates, source: 'ExchangeRate-API' };
    },
  },

  // ── Countries / Geography ────────────────────────────────────────────────────
  {
    id: 'rest-countries',
    name: 'REST Countries',
    baseUrl: 'https://restcountries.com',
    categories: ['geography', 'countries', 'government'],
    keywords: ['country', 'countries', 'nation', 'capital', 'population', 'flag', 'region', 'continent'],
    description: 'Free country data — flags, capitals, languages, populations. No key required.',
    buildUrl: (p) => {
      if (p.name) return `https://restcountries.com/v3.1/name/${encodeURIComponent(p.name)}`;
      if (p.code) return `https://restcountries.com/v3.1/alpha/${p.code}`;
      return 'https://restcountries.com/v3.1/all?fields=name,capital,population,flags,region,subregion';
    },
    testParams: { name: 'Ghana' },
    responseValidator: (d) => Array.isArray(d) && d.length > 0,
    responsePreview: (d) => Array.isArray(d) ? `${d.length} result(s)` : 'country data',
  },

  // ── IP / Geolocation ─────────────────────────────────────────────────────────
  {
    id: 'ip-api',
    name: 'IP-API (Geolocation)',
    baseUrl: 'http://ip-api.com',
    categories: ['geolocation', 'ip', 'location'],
    keywords: ['ip', 'geolocation', 'location', 'ip address', 'detect location', 'geoip'],
    description: 'Free IP geolocation — country, city, timezone, ISP. No key required.',
    buildUrl: (p) => `http://ip-api.com/json/${p.ip || ''}?fields=status,country,city,lat,lon,timezone,isp`,
    testParams: { ip: '8.8.8.8' },
    responseValidator: (d) => isObj(d) && (d as Record<string, unknown>).status === 'success',
    responsePreview: (d) => {
      if (isObj(d)) return `${(d as Record<string,unknown>).city}, ${(d as Record<string,unknown>).country}`;
      return 'ip data';
    },
  },

  // ── Random / Test Data ───────────────────────────────────────────────────────
  {
    id: 'randomuser',
    name: 'Random User Generator',
    baseUrl: 'https://randomuser.me',
    categories: ['testing', 'mock-data', 'users'],
    keywords: ['random user', 'fake user', 'test data', 'mock user', 'sample user'],
    description: 'Generate random user profiles for testing. No key required.',
    buildUrl: (p) => `https://randomuser.me/api/?results=${p.count || '10'}&nat=${p.nat || 'us,gb'}`,
    testParams: { count: '5' },
    responseValidator: (d) => isObj(d) && Array.isArray((d as Record<string,unknown>).results),
    responsePreview: (d) => {
      if (isObj(d) && Array.isArray(d.results)) return `${d.results.length} user(s)`;
      return 'user data';
    },
  },

  // ── Quotes ───────────────────────────────────────────────────────────────────
  {
    id: 'quotable',
    name: 'Quotable (Quotes)',
    baseUrl: 'https://api.quotable.io',
    categories: ['quotes', 'inspiration', 'content'],
    keywords: ['quote', 'quotes', 'inspiration', 'motivational', 'saying'],
    description: 'Free quotes API — 1,000+ curated quotes with author data. No key required.',
    buildUrl: (p) => {
      const count = p.count || '5';
      const tag = p.tag ? `&tags=${p.tag}` : '';
      return `https://api.quotable.io/quotes/random?limit=${count}${tag}`;
    },
    testParams: { count: '3' },
    responseValidator: (d) => Array.isArray(d) && d.length > 0,
    responsePreview: (d) => Array.isArray(d) ? `${d.length} quote(s)` : 'quotes',
  },

  // ── Food / Nutrition ──────────────────────────────────────────────────────────
  {
    id: 'open-food-facts',
    name: 'Open Food Facts',
    baseUrl: 'https://world.openfoodfacts.org',
    categories: ['food', 'nutrition', 'health'],
    keywords: ['food', 'nutrition', 'calories', 'ingredients', 'barcode', 'product', 'diet'],
    description: 'Free food and nutrition database — 2M+ products. No key required.',
    buildUrl: (p) => {
      if (p.barcode) return `https://world.openfoodfacts.org/api/v0/product/${p.barcode}.json`;
      return `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(p.q || 'rice')}&search_simple=1&action=process&json=1&page_size=10`;
    },
    testParams: { q: 'rice' },
    responseValidator: (d) => isObj(d) && ('product' in d || 'products' in d || 'count' in d),
    responsePreview: (d) => {
      if (isObj(d) && typeof d.count === 'number') return `${d.count} product(s) found`;
      return 'food data';
    },
  },

  // ── Space / Astronomy ────────────────────────────────────────────────────────
  {
    id: 'open-notify-iss',
    name: 'Open Notify (ISS Location)',
    baseUrl: 'http://api.open-notify.org',
    categories: ['space', 'astronomy', 'science'],
    keywords: ['iss', 'space station', 'space', 'satellite', 'astronaut', 'orbit'],
    description: 'Real-time ISS location and astronaut data. No key required.',
    buildUrl: (_p) => 'http://api.open-notify.org/iss-now.json',
    testParams: {},
    responseValidator: (d) => isObj(d) && 'iss_position' in d,
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.iss_position)) {
        const pos = d.iss_position as Record<string, unknown>;
        return `ISS at ${pos.latitude}, ${pos.longitude}`;
      }
      return 'ISS data';
    },
  },

  // ── Jokes / Entertainment ────────────────────────────────────────────────────
  {
    id: 'jokeapi',
    name: 'JokeAPI',
    baseUrl: 'https://v2.jokeapi.dev',
    categories: ['entertainment', 'jokes', 'humor', 'fun'],
    keywords: ['joke', 'humor', 'funny', 'comedy', 'laugh'],
    description: 'Free joke API — 500+ jokes in multiple categories. No key required.',
    buildUrl: (p) => {
      const cat = p.category || 'Any';
      const type = p.type ? `&type=${p.type}` : '';
      return `https://v2.jokeapi.dev/joke/${cat}?safe-mode${type}`;
    },
    testParams: { category: 'Programming' },
    responseValidator: (d) => isObj(d) && 'type' in d,
    responsePreview: (d) => {
      if (isObj(d)) return (d.joke || d.setup) as string || 'joke returned';
      return 'joke data';
    },
  },

  // ── Dog / Cat Images ─────────────────────────────────────────────────────────
  {
    id: 'dog-ceo',
    name: 'Dog CEO (Dog Images)',
    baseUrl: 'https://dog.ceo',
    categories: ['images', 'animals', 'pets', 'entertainment'],
    keywords: ['dog', 'puppy', 'pet', 'animal', 'image'],
    description: 'Free random dog images — 20,000+ images. No key required.',
    buildUrl: (p) => {
      const breed = p.breed ? `breed/${p.breed}/` : '';
      return `https://dog.ceo/api/${breed}images/random`;
    },
    testParams: {},
    responseValidator: (d) => isObj(d) && d.status === 'success',
    responsePreview: (d) => isObj(d) ? String(d.message || '').slice(0, 60) : 'dog image',
  },

  // ── Age / Gender / Nationality Prediction ─────────────────────────────────────
  {
    id: 'agify',
    name: 'Agify (Age Prediction)',
    baseUrl: 'https://api.agify.io',
    categories: ['tools', 'prediction', 'demographics'],
    keywords: ['age', 'predict age', 'name age', 'demographic'],
    description: 'Predict age from a first name. No key required.',
    buildUrl: (p) => `https://api.agify.io/?name=${encodeURIComponent(p.name || 'John')}`,
    testParams: { name: 'John' },
    responseValidator: (d) => isObj(d) && 'age' in d,
    responsePreview: (d) => isObj(d) ? `Age: ${(d as Record<string,unknown>).age}` : 'age data',
  },

  // ── Crypto (public tier) ─────────────────────────────────────────────────────
  {
    id: 'coingecko-free',
    name: 'CoinGecko (Public)',
    baseUrl: 'https://api.coingecko.com',
    categories: ['crypto', 'finance', 'blockchain'],
    keywords: ['crypto', 'bitcoin', 'ethereum', 'coin', 'token', 'blockchain', 'defi', 'price'],
    description: 'Free crypto prices and market data — no key required for public tier.',
    buildUrl: (p) => {
      const vs = p.vs_currency || 'usd';
      const ids = p.ids || 'bitcoin,ethereum,binancecoin';
      return `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true`;
    },
    testParams: { vs_currency: 'usd', ids: 'bitcoin,ethereum' },
    responseValidator: (d) => isObj(d) && Object.keys(d).length > 0,
    responsePreview: (d) => {
      if (isObj(d) && isObj(d.bitcoin)) {
        const btc = d.bitcoin as Record<string, unknown>;
        return `BTC: $${btc.usd}`;
      }
      return 'crypto prices';
    },
  },
];

export function findPublicApis(need: string): PublicApiEntry[] {
  const needLower = need.toLowerCase();
  return PUBLIC_API_REGISTRY.filter(entry => {
    const combined = [...entry.categories, ...entry.keywords, entry.name].join(' ').toLowerCase();
    return needLower.split(/\s+/).some(word => word.length > 3 && combined.includes(word));
  });
}

export function getPublicApiById(id: string): PublicApiEntry | undefined {
  return PUBLIC_API_REGISTRY.find(e => e.id === id);
}
