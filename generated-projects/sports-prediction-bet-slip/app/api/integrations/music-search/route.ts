/**
 * GET /api/integrations/music-search
 *
 * NOTE: This endpoint has been repurposed to return live competition/standings data
 * from LiveScore 6. A sports prediction app has no need for music search.
 *
 * GET /api/integrations/music-search?q=<competition name>
 *   → Returns competition stages from LiveScore 6 matching the query
 *
 * This route name is preserved so existing UI links don't break.
 * Rename the route file once the frontend is updated.
 */

import { NextRequest, NextResponse } from 'next/server';

const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY || '';
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

export async function GET(request: NextRequest) {
  const q        = new URL(request.url).searchParams.get('q') || '';
  const date     = new URL(request.url).searchParams.get('date') || '';
  const category = new URL(request.url).searchParams.get('category') || 'soccer';

  if (!RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 503 });
  }

  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const qp = new URLSearchParams({ Category: category, Timezone: '0', Date: date || today });

  try {
    const res = await fetch(`https://${LIVESCORE_HOST}/matches/v2/list-by-date?${qp}`, {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': LIVESCORE_HOST },
      next: { revalidate: 120 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `LiveScore returned HTTP ${res.status}` }, { status: res.status });
    }

    const json = await res.json() as { Stages?: Array<{ Sid:string; Snm:string; Cnm:string; Ccd?:string; Events?:unknown[] }> };
    let stages = json.Stages ?? [];

    if (q) {
      const qLower = q.toLowerCase();
      stages = stages.filter(s =>
        s.Cnm?.toLowerCase().includes(qLower) || s.Snm?.toLowerCase().includes(qLower)
      );
    }

    return NextResponse.json({
      competitions: stages.map(s => ({
        id: s.Sid,
        name: s.Snm,
        country: s.Cnm,
        country_code: s.Ccd,
        match_count: s.Events?.length ?? 0,
      })),
      total: stages.length,
      source: 'LiveScore 6',
      date: date || today,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
