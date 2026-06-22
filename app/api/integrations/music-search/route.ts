/**
 * Platform Integration: Music Search (Shazam)
 * GET /api/integrations/music-search?q=one+dance
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi } from '@/services/rapidapi-connector';

const MUSIC_PROVIDERS = [
  {
    host: 'shazam-core.p.rapidapi.com',
    url: 'https://shazam-core.p.rapidapi.com/v1/search/multi',
    buildParams: (q: string) => ({ search_type: 'SONGS_ARTISTS', query: q }),
    extractTracks: (data: unknown) => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      const hits = ((d.tracks as Record<string,unknown>)?.hits as Record<string,unknown>[]) ?? [];
      return hits.map((h: Record<string,unknown>) => {
        const t = h.track as Record<string,unknown>;
        return { title: t?.title, artist: t?.subtitle, image: (t?.images as Record<string,unknown>)?.coverart, previewUrl: null };
      });
    },
  },
  {
    host: 'shazam.p.rapidapi.com',
    url: 'https://shazam.p.rapidapi.com/search',
    buildParams: (q: string) => ({ term: q, locale: 'en-US', offset: '0', limit: '10' }),
    extractTracks: (data: unknown) => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      const hits = ((d.tracks as Record<string,unknown>)?.hits as Record<string,unknown>[]) ?? [];
      return hits.map((h: Record<string,unknown>) => {
        const t = h.track as Record<string,unknown>;
        return { title: t?.title, artist: t?.subtitle, image: (t?.images as Record<string,unknown>)?.coverart, previewUrl: null };
      });
    },
  },
  {
    host: 'deezerdevs-deezer.p.rapidapi.com',
    url: 'https://deezerdevs-deezer.p.rapidapi.com/search',
    buildParams: (q: string) => ({ q }),
    extractTracks: (data: unknown) => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (!Array.isArray(d.data)) return null;
      return (d.data as Record<string,unknown>[]).map(t => ({
        title: t.title,
        artist: (t.artist as Record<string,unknown>)?.name,
        image: (t.album as Record<string,unknown>)?.cover_medium,
        previewUrl: t.preview,
      }));
    },
  },
];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || searchParams.get('term') || '';
  if (!query) return NextResponse.json({ error: 'Missing ?q= parameter' }, { status: 400 });

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY is not configured.' }, { status: 503 });
  }

  const errors: string[] = [];
  for (const p of MUSIC_PROVIDERS) {
    const result = await proxyRapidApi({ url: p.url, host: p.host, params: p.buildParams(query) });
    if (result.ok && result.data) {
      const tracks = p.extractTracks(result.data);
      if (tracks && tracks.length > 0) {
        return NextResponse.json({ tracks, provider: p.host });
      }
    }
    errors.push(`[${p.host}] ${result.error || 'No tracks found'}`);
  }

  return NextResponse.json({ error: 'Music search API unavailable', details: errors }, { status: 502 });
}
