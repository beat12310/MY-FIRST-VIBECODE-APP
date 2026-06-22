/**
 * Platform Integration: News
 * GET /api/integrations/news?q=technology&lang=en&count=10
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi } from '@/services/rapidapi-connector';

interface NormalizedArticle {
  title: string;
  description: string;
  url: string;
  image?: string;
  publishedAt: string;
  source: string;
}

const NEWS_PROVIDERS = [
  {
    host: 'bing-news-search1.p.rapidapi.com',
    url: 'https://bing-news-search1.p.rapidapi.com/news/search',
    buildParams: (q: string, lang: string, count: string) => ({
      q: q || 'world news',
      mkt: lang === 'en' ? 'en-US' : lang,
      safeSearch: 'Off',
      textFormat: 'Raw',
      freshness: 'Day',
      count,
    }),
    normalize: (data: unknown): NormalizedArticle[] => {
      if (!data || typeof data !== 'object') return [];
      const d = data as Record<string, unknown>;
      if (!Array.isArray(d.value)) return [];
      return (d.value as Record<string, unknown>[]).map(a => ({
        title: a.name as string,
        description: a.description as string,
        url: a.url as string,
        image: (a.image as Record<string, Record<string, string>> | undefined)?.thumbnail?.contentUrl,
        publishedAt: a.datePublished as string,
        source: ((a.provider as Record<string, string>[])?.[0])?.name ?? 'Unknown',
      }));
    },
  },
  {
    host: 'newscatcher.p.rapidapi.com',
    url: 'https://newscatcher.p.rapidapi.com/v2/search',
    buildParams: (q: string, lang: string, count: string) => ({
      q: q || 'world',
      lang,
      sort_by: 'relevancy',
      page_size: count,
      page: '1',
    }),
    normalize: (data: unknown): NormalizedArticle[] => {
      if (!data || typeof data !== 'object') return [];
      const d = data as Record<string, unknown>;
      if (!Array.isArray(d.articles)) return [];
      return (d.articles as Record<string, unknown>[]).map(a => ({
        title: a.title as string,
        description: a.summary as string,
        url: a.link as string,
        image: a.media as string | undefined,
        publishedAt: a.published_date as string,
        source: a.clean_url as string,
      }));
    },
  },
];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || searchParams.get('query') || '';
  const lang = searchParams.get('lang') || 'en';
  const count = searchParams.get('count') || searchParams.get('limit') || '10';

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY is not configured.' }, { status: 503 });
  }

  const errors: string[] = [];
  for (const p of NEWS_PROVIDERS) {
    const result = await proxyRapidApi({ url: p.url, host: p.host, params: p.buildParams(q, lang, count) });
    if (result.ok && result.data) {
      const articles = p.normalize(result.data);
      if (articles.length > 0) {
        return NextResponse.json({ articles, total: articles.length, provider: p.host });
      }
    }
    errors.push(`[${p.host}] ${result.error || 'No articles'}`);
  }

  return NextResponse.json({ error: 'News API unavailable', details: errors }, { status: 502 });
}
