/**
 * GET /api/matches
 *
 * Returns live and scheduled football matches from LiveScore 6 (RapidAPI).
 * RAPIDAPI_KEY is injected into this app's .env.local by the DWOMOH platform.
 *
 * Query params:
 *   status=live|scheduled|finished
 *   league=<partial name>
 *   country=<partial>
 *   date=YYYYMMDD  (scheduled matches for a specific date)
 *   q=<team/league search>
 */

import { NextRequest, NextResponse } from 'next/server';

const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY || '';
const LIVESCORE_HOST  = 'livescore6.p.rapidapi.com';

interface LiveScoreStage {
  Sid: string;
  Snm: string;
  Cnm: string;
  Ccd?: string;
  Events?: LiveScoreEvent[];
}

interface LiveScoreEvent {
  Eid: string;
  T1: Array<{ Nm: string; Img?: string }>;
  T2: Array<{ Nm: string; Img?: string }>;
  Tr1?: string;
  Tr2?: string;
  Eps?: string;
  Esd?: string;
}

async function fetchFromLiveScore(date?: string): Promise<LiveScoreStage[]> {
  const endpoint = date
    ? `https://${LIVESCORE_HOST}/matches/v2/list-by-date`
    : `https://${LIVESCORE_HOST}/matches/v2/list-live`;

  const qp = new URLSearchParams({ Category: 'soccer', Timezone: '0' });
  if (date) qp.set('Date', date);

  const res = await fetch(`${endpoint}?${qp}`, {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': LIVESCORE_HOST,
    },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LiveScore 6 HTTP ${res.status}: ${body.slice(0, 100)}`);
  }

  const json = await res.json() as { Stages?: LiveScoreStage[] };
  return json.Stages ?? [];
}

function normalizeMatch(ev: LiveScoreEvent, stage: LiveScoreStage) {
  const eps = (ev.Eps ?? '').toLowerCase();
  let status: 'live' | 'scheduled' | 'finished' = 'scheduled';
  if (['fin', 'ft', 'aet', 'pen', 'canc', 'postp', 'abd'].includes(eps)) {
    status = 'finished';
  } else if (eps && !['ns', 'tbd', ''].includes(eps)) {
    status = 'live';
  }

  let kickoff_time = new Date().toISOString();
  if (ev.Esd) {
    try {
      const s = String(ev.Esd);
      kickoff_time = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00Z`;
    } catch { /* keep default */ }
  }

  return {
    id: ev.Eid,
    fixture_id: parseInt(ev.Eid, 10) || 0,
    league: stage.Cnm || stage.Snm || 'Unknown Competition',
    stage_name: stage.Snm,
    country: stage.Ccd ?? '',
    home_team: ev.T1?.[0]?.Nm ?? 'Home',
    away_team: ev.T2?.[0]?.Nm ?? 'Away',
    home_team_logo: ev.T1?.[0]?.Img,
    away_team_logo: ev.T2?.[0]?.Img,
    kickoff_time,
    status,
    home_score: ev.Tr1 != null ? parseInt(ev.Tr1, 10) : undefined,
    away_score: ev.Tr2 != null ? parseInt(ev.Tr2, 10) : undefined,
    minute: status === 'live' ? ev.Eps : undefined,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const statusFilter  = searchParams.get('status') || '';
  const leagueFilter  = searchParams.get('league') || '';
  const countryFilter = searchParams.get('country') || '';
  const searchFilter  = searchParams.get('q') || '';
  const dateParam     = searchParams.get('date') || '';

  if (!RAPIDAPI_KEY) {
    return NextResponse.json(
      { error: 'RAPIDAPI_KEY not configured in this app', matches: [], total: 0 },
      { status: 503 },
    );
  }

  try {
    // If no date requested, get today's matches alongside live
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const stages = await fetchFromLiveScore(dateParam || today);

    let matches = stages.flatMap(stage =>
      (stage.Events ?? []).map(ev => normalizeMatch(ev, stage))
    );

    if (statusFilter) matches = matches.filter(m => m.status === statusFilter);
    if (leagueFilter) {
      const q = leagueFilter.toLowerCase();
      matches = matches.filter(m =>
        m.league.toLowerCase().includes(q) || m.stage_name.toLowerCase().includes(q)
      );
    }
    if (countryFilter) {
      matches = matches.filter(m => m.country.toLowerCase().includes(countryFilter.toLowerCase()));
    }
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      matches = matches.filter(m =>
        m.home_team.toLowerCase().includes(q) ||
        m.away_team.toLowerCase().includes(q) ||
        m.league.toLowerCase().includes(q)
      );
    }

    const order = { live: 0, scheduled: 1, finished: 2 } as const;
    matches.sort((a, b) => {
      const d = (order[a.status] ?? 1) - (order[b.status] ?? 1);
      if (d !== 0) return d;
      return new Date(a.kickoff_time).getTime() - new Date(b.kickoff_time).getTime();
    });

    return NextResponse.json({
      matches,
      total: matches.length,
      source: 'LiveScore 6 (RapidAPI)',
      date: dateParam || today,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/matches] error:', msg);
    return NextResponse.json(
      { error: msg, matches: [], total: 0 },
      { status: 502 },
    );
  }
}
