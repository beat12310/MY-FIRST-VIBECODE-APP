/**
 * GET /api/integrations/live-scores
 *
 * Direct LiveScore 6 proxy — returns raw scored stages for soccer matches.
 * Use this when you need the full LiveScore 6 response structure.
 *
 * Query params:
 *   category=soccer|cricket|tennis|basketball (default: soccer)
 *   date=YYYYMMDD (default: live only)
 *   timezone=0 (default: UTC)
 */

import { NextRequest, NextResponse } from 'next/server';

const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY || '';
const LIVESCORE_HOST = 'livescore6.p.rapidapi.com';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category') || 'soccer';
  const date     = searchParams.get('date') || '';
  const timezone = searchParams.get('timezone') || '0';

  if (!RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 503 });
  }

  const endpoint = date
    ? `https://${LIVESCORE_HOST}/matches/v2/list-by-date`
    : `https://${LIVESCORE_HOST}/matches/v2/list-live`;

  const qp = new URLSearchParams({ Category: category, Timezone: timezone });
  if (date) qp.set('Date', date);

  try {
    const res = await fetch(`${endpoint}?${qp}`, {
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': LIVESCORE_HOST,
      },
      next: { revalidate: 30 },
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: `LiveScore 6 returned HTTP ${res.status}`, detail: data },
        { status: res.status },
      );
    }

    return NextResponse.json({
      ...data,
      _meta: {
        source: 'LiveScore 6 (RapidAPI)',
        host: LIVESCORE_HOST,
        endpoint: date ? 'list-by-date' : 'list-live',
        date: date || 'live',
        category,
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
