/**
 * Web Search Service
 *
 * Provides live internet search capabilities for the DWOMOH engineering engine.
 * Used by the root-cause + repair flow to find solutions for errors it has not
 * seen before and cannot fix with local knowledge alone.
 *
 * Primary:  Google Search via RapidAPI (RAPIDAPI_KEY in .env.local)
 * Fallback: Bing Search via RapidAPI
 * Final:    returns empty array gracefully if no key or quota exceeded
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  source: 'google' | 'bing' | 'none';
  durationMs: number;
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// ─── Google Search ────────────────────────────────────────────────────────────

async function googleSearch(query: string, limit: number): Promise<SearchResult[]> {
  if (!RAPIDAPI_KEY) return [];

  const res = await fetch(
    `https://google-search72.p.rapidapi.com/search?q=${encodeURIComponent(query)}&num=${limit}&gl=us&lr=en-US`,
    {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'google-search72.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(8000),
    }
  );

  if (!res.ok) return [];

  const data = await res.json() as { items?: Array<{ title?: string; link?: string; snippet?: string }> };

  return (data.items ?? []).slice(0, limit).map(item => ({
    title: item.title ?? '',
    url: item.link ?? '',
    snippet: item.snippet ?? '',
  }));
}

// ─── Bing fallback ────────────────────────────────────────────────────────────

async function bingSearch(query: string, limit: number): Promise<SearchResult[]> {
  if (!RAPIDAPI_KEY) return [];

  const res = await fetch(
    `https://bing-web-search1.p.rapidapi.com/search?q=${encodeURIComponent(query)}&count=${limit}&mkt=en-US&safeSearch=Off&textFormat=Raw`,
    {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'bing-web-search1.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(8000),
    }
  );

  if (!res.ok) return [];

  const data = await res.json() as { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> } };
  const webResults = data.webPages?.value ?? [];

  return webResults.slice(0, limit).map(r => ({
    title: r.name ?? '',
    url: r.url ?? '',
    snippet: r.snippet ?? '',
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search the web for information. Used by the repair engine to find solutions
 * for errors it hasn't seen before.
 *
 * Returns up to `limit` results. Gracefully returns empty array when no API
 * key is configured or the search quota is exceeded.
 */
export async function searchWeb(query: string, limit = 5): Promise<SearchResponse> {
  const t0 = Date.now();

  if (!RAPIDAPI_KEY) {
    return { results: [], query, source: 'none', durationMs: 0 };
  }

  // Try Google first, fall back to Bing
  try {
    const results = await googleSearch(query, limit);
    if (results.length > 0) {
      return { results, query, source: 'google', durationMs: Date.now() - t0 };
    }
  } catch { /* fall through to Bing */ }

  try {
    const results = await bingSearch(query, limit);
    return { results, query, source: 'bing', durationMs: Date.now() - t0 };
  } catch { /* fall through */ }

  return { results: [], query, source: 'none', durationMs: Date.now() - t0 };
}

/**
 * Build a targeted search query for a Next.js / React error.
 * Strips long stack traces and file paths, extracts the key error message.
 */
export function buildErrorSearchQuery(error: string, projectContext = 'Next.js'): string {
  // Strip file paths and line numbers
  const cleaned = error
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')       // at Function.name (file:line)
    .replace(/\/[^\s"']+\.\w{1,5}:\d+:\d+/g, '') // /path/to/file.ts:10:3
    .replace(/\n\s*/g, ' ')                        // collapse newlines
    .replace(/\s{2,}/g, ' ')                       // collapse spaces
    .trim()
    .slice(0, 150);                                // keep it short

  return `${projectContext} ${cleaned} fix solution`;
}

/**
 * Format search results for inclusion in an AI repair prompt.
 */
export function formatSearchResultsForPrompt(response: SearchResponse): string {
  if (response.results.length === 0) return '';

  const lines = [
    `\n## Web Search Results (${response.source}) — Query: "${response.query}"`,
    `The following publicly available solutions may be relevant:\n`,
  ];

  for (const r of response.results) {
    lines.push(`**${r.title}**`);
    if (r.snippet) lines.push(r.snippet);
    lines.push('');
  }

  return lines.join('\n');
}
