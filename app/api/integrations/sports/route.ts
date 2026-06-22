/**
 * Platform Integration: Sports Scores & Fixtures
 * GET /api/integrations/sports?type=fixtures&league=39&season=2024
 * GET /api/integrations/sports?type=live
 * GET /api/integrations/sports?type=standings&league=39&season=2024
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi } from '@/services/rapidapi-connector';

const API_FOOTBALL_HOST = 'api-football-v1.p.rapidapi.com';
const BASE_URL = 'https://api-football-v1.p.rapidapi.com/v3';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'fixtures';
  const league = searchParams.get('league') || '39'; // Premier League
  const season = searchParams.get('season') || '2024';
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY is not configured.' }, { status: 503 });
  }

  let endpoint = '';
  let params: Record<string, string> = {};

  switch (type) {
    case 'live':
      endpoint = `${BASE_URL}/fixtures`;
      params = { live: 'all' };
      break;
    case 'standings':
      endpoint = `${BASE_URL}/standings`;
      params = { league, season };
      break;
    case 'leagues':
      endpoint = `${BASE_URL}/leagues`;
      params = searchParams.get('country') ? { country: searchParams.get('country')! } : { current: 'true' };
      break;
    default: // fixtures
      endpoint = `${BASE_URL}/fixtures`;
      params = { league, season, date };
  }

  const result = await proxyRapidApi({ url: endpoint, host: API_FOOTBALL_HOST, params });

  if (!result.ok) {
    // Try fallback provider
    return NextResponse.json({ error: 'Sports API unavailable', details: [result.error] }, { status: 502 });
  }

  return NextResponse.json(result.data);
}
