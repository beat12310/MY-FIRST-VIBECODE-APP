/**
 * Platform Integration: Currency Exchange
 * GET /api/integrations/currency?from=USD&to=GHS&amount=1
 * GET /api/integrations/currency?base=USD  (returns all rates)
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi } from '@/services/rapidapi-connector';

const CURRENCY_PROVIDERS = [
  {
    host: 'currency-exchange.p.rapidapi.com',
    singleUrl: 'https://currency-exchange.p.rapidapi.com/exchange',
    buildSingleParams: (from: string, to: string) => ({ from, to, q: '1.0' }),
    extractRate: (data: unknown) => typeof data === 'number' ? data : null,
    allRatesUrl: null as string | null,
  },
  {
    host: 'exchange-rate-api.p.rapidapi.com',
    singleUrl: null as string | null,
    buildSingleParams: () => ({}),
    extractRate: () => null,
    allRatesUrl: 'https://exchange-rate-api.p.rapidapi.com/rapid/latest',
  },
];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const from = (searchParams.get('from') || 'USD').toUpperCase();
  const to = (searchParams.get('to') || 'GHS').toUpperCase();
  const amount = parseFloat(searchParams.get('amount') || '1');
  const wantAll = searchParams.has('base');
  const base = (searchParams.get('base') || from).toUpperCase();

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY is not configured.' }, { status: 503 });
  }

  const errors: string[] = [];

  // Try to get all rates first (for base query or as a fallback for single pair)
  for (const p of CURRENCY_PROVIDERS) {
    if (p.allRatesUrl) {
      const result = await proxyRapidApi({
        url: `${p.allRatesUrl}/${base}`,
        host: p.host,
      });
      if (result.ok && result.data && typeof result.data === 'object') {
        const d = result.data as Record<string, unknown>;
        const rates = (d.rates || d.conversion_rates) as Record<string, number> | undefined;
        if (rates) {
          if (wantAll) return NextResponse.json({ base, rates });
          const rate = rates[to];
          if (rate) return NextResponse.json({ from, to, rate, amount, result: rate * amount });
        }
      }
      if (result.error) errors.push(`[${p.host}] ${result.error}`);
    }
  }

  // Try single-pair lookup
  for (const p of CURRENCY_PROVIDERS) {
    if (p.singleUrl) {
      const result = await proxyRapidApi({
        url: p.singleUrl,
        host: p.host,
        params: p.buildSingleParams(from, to),
      });
      if (result.ok && result.data !== undefined) {
        const rate = p.extractRate(result.data);
        if (rate !== null) {
          return NextResponse.json({ from, to, rate, amount, result: rate * amount });
        }
      }
      if (result.error) errors.push(`[${p.host}] ${result.error}`);
    }
  }

  return NextResponse.json({ error: 'Currency API unavailable', details: errors }, { status: 502 });
}
