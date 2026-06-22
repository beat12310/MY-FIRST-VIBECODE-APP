/**
 * GET /api/integrations/odds
 *
 * Returns live betting odds from Bet365 (primary) with Betway fallback.
 * If neither is subscribed, returns algorithmically derived market odds
 * calculated from live match data so the UI always gets usable numbers.
 *
 * Query params:
 *   sport_id=1     (1=soccer, 13=tennis, 18=basketball)
 *   match_id=<id>  filter by match (uses home/away score for live odds)
 *   market=1x2|ou25|btts (not currently filtered here — returned raw)
 */

import { NextRequest, NextResponse } from 'next/server';

const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY || '';
const BET365_HOST     = 'bet365.p.rapidapi.com';
const BETWAY_HOST     = 'betway2.p.rapidapi.com';
const LIVESCORE_HOST  = 'livescore6.p.rapidapi.com';

async function tryBet365(sportId: string) {
  const res = await fetch(
    `https://${BET365_HOST}/v1/bet365/upcoming?sport_id=${sportId}`,
    {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': BET365_HOST },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return { source: 'Bet365', data };
}

async function tryBetway() {
  const res = await fetch(`https://${BETWAY_HOST}/sports`, {
    headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': BETWAY_HOST },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { source: 'Betway', data };
}

/**
 * Generate market odds from live match data when no odds provider is available.
 * Based on current score, match status, and competition context.
 */
async function derivedOddsFromLiveData(matchId?: string) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const qp = new URLSearchParams({ Category: 'soccer', Timezone: '0', Date: today });

  try {
    const res = await fetch(`https://${LIVESCORE_HOST}/matches/v2/list-by-date?${qp}`, {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': LIVESCORE_HOST },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;

    const json = await res.json() as { Stages?: Array<{ Cnm: string; Events?: Array<{
      Eid: string; T1: Array<{Nm:string}>; T2: Array<{Nm:string}>;
      Tr1?: string; Tr2?: string; Eps?: string;
    }> }> };

    const events = (json.Stages ?? []).flatMap(s =>
      (s.Events ?? []).map(ev => ({ ...ev, competition: s.Cnm }))
    );

    const targets = matchId ? events.filter(e => e.Eid === matchId) : events;

    const odds = targets.map(ev => {
      const home = ev.T1?.[0]?.Nm ?? 'Home';
      const away = ev.T2?.[0]?.Nm ?? 'Away';
      const homeScore = ev.Tr1 != null ? parseInt(ev.Tr1, 10) : NaN;
      const awayScore = ev.Tr2 != null ? parseInt(ev.Tr2, 10) : NaN;
      const hasScore = !isNaN(homeScore) && !isNaN(awayScore);
      const eps = (ev.Eps ?? '').toLowerCase();
      const minuteMatch = eps.match(/^(\d+)/);
      const minute = minuteMatch ? parseInt(minuteMatch[1], 10) : 0;
      const remainingMins = Math.max(0, 90 - minute);

      // Derive 1X2 odds from current state
      let homeOdds = 2.20, drawOdds = 3.30, awayOdds = 3.50;
      if (hasScore && minute > 0) {
        const diff = homeScore - awayScore;
        if (diff > 0) {
          const factor = Math.exp(-diff * remainingMins / 800);
          homeOdds = parseFloat((1.1 + factor * 0.8).toFixed(2));
          drawOdds = parseFloat((2.5 + (1 - factor) * 2).toFixed(2));
          awayOdds = parseFloat((4.0 + (1 - factor) * 4).toFixed(2));
        } else if (diff < 0) {
          const factor = Math.exp(diff * remainingMins / 800);
          awayOdds = parseFloat((1.1 + factor * 0.8).toFixed(2));
          drawOdds = parseFloat((2.5 + (1 - factor) * 2).toFixed(2));
          homeOdds = parseFloat((4.0 + (1 - factor) * 4).toFixed(2));
        } else {
          // Level — adjust by time remaining
          drawOdds = parseFloat((2.0 + remainingMins / 90).toFixed(2));
          homeOdds = parseFloat((2.8 - remainingMins / 120).toFixed(2));
          awayOdds = parseFloat((3.2 - remainingMins / 120).toFixed(2));
        }
      }

      const totalGoals = hasScore ? homeScore + awayScore : 0;
      const projectedGoals = minute > 0 ? (totalGoals / minute) * 90 : 2.6;
      const overOdds   = parseFloat(Math.max(1.10, 2.5 - (projectedGoals - 2.5) * 0.4).toFixed(2));
      const underOdds  = parseFloat(Math.max(1.10, 2.5 + (projectedGoals - 2.5) * 0.4).toFixed(2));
      const bttsYes    = hasScore && homeScore > 0 && awayScore > 0 ? 1.01 : 1.75;
      const bttsNo     = hasScore && homeScore > 0 && awayScore > 0 ? 50.0 : 2.05;

      return {
        match_id: ev.Eid,
        home_team: home,
        away_team: away,
        competition: ev.competition,
        current_score: hasScore ? `${homeScore}-${awayScore}` : null,
        minute: minute || null,
        markets: {
          '1X2': { home: homeOdds, draw: drawOdds, away: awayOdds },
          'over_under_2_5': { over: overOdds, under: underOdds },
          'btts': { yes: bttsYes, no: bttsNo },
        },
      };
    });

    return { source: 'derived_from_livescore6', odds };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sportId = searchParams.get('sport_id') || '1';
  const matchId = searchParams.get('match_id') || '';

  if (!RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 503 });
  }

  // Try Bet365 first, then Betway, then derive from live data
  const [bet365Result, betwayResult] = await Promise.allSettled([
    tryBet365(sportId),
    tryBetway(),
  ]);

  const bet365 = bet365Result.status === 'fulfilled' ? bet365Result.value : null;
  const betway = betwayResult.status === 'fulfilled' ? betwayResult.value : null;

  if (bet365) {
    return NextResponse.json({
      ...bet365,
      fallback: false,
      providers_tried: ['bet365'],
    });
  }

  if (betway) {
    return NextResponse.json({
      ...betway,
      fallback: false,
      providers_tried: ['bet365 (failed)', 'betway'],
    });
  }

  // Neither odds provider subscribed — derive from live match data
  const derived = await derivedOddsFromLiveData(matchId || undefined);
  if (derived) {
    return NextResponse.json({
      ...derived,
      fallback: true,
      note: 'Odds derived algorithmically from live match data (no Bet365/Betway subscription detected)',
      providers_tried: ['bet365 (not subscribed)', 'betway (not subscribed)', 'livescore6_derived'],
    });
  }

  return NextResponse.json(
    { error: 'No odds provider available and live data fetch failed', providers_tried: ['bet365', 'betway', 'derived'] },
    { status: 502 },
  );
}
