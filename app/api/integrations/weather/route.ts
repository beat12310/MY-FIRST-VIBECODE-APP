/**
 * Platform Integration: Weather
 * GET /api/integrations/weather?city=Accra&units=metric
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi } from '@/services/rapidapi-connector';

const WEATHER_PROVIDERS = [
  {
    host: 'open-weather-map.p.rapidapi.com',
    url: 'https://open-weather-map.p.rapidapi.com/weather',
    buildParams: (city: string, units: string) => ({ q: city, units }),
    normalize: (data: unknown) => data, // already normalized
  },
  {
    host: 'weatherapi-com.p.rapidapi.com',
    url: 'https://weatherapi-com.p.rapidapi.com/v1/current.json',
    buildParams: (city: string) => ({ q: city }),
    normalize: (data: unknown) => {
      if (!data || typeof data !== 'object') return data;
      const d = data as Record<string, Record<string, unknown>>;
      // Normalize to OWM-like shape for easy frontend consumption
      return {
        name: d.location?.name,
        country: d.location?.country,
        main: {
          temp: d.current?.temp_c,
          feels_like: d.current?.feelslike_c,
          humidity: d.current?.humidity,
        },
        weather: [{ description: (d.current?.condition as Record<string,unknown>)?.text, icon: (d.current?.condition as Record<string,unknown>)?.icon }],
        wind: { speed: d.current?.wind_kph },
        _provider: 'weatherapi',
      };
    },
  },
];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get('city') || searchParams.get('q') || 'London';
  const units = searchParams.get('units') || 'metric';

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY is not configured.' }, { status: 503 });
  }

  const errors: string[] = [];
  for (const p of WEATHER_PROVIDERS) {
    const result = await proxyRapidApi({
      url: p.url,
      host: p.host,
      params: p.buildParams(city, units),
    });

    if (result.ok && result.data) {
      return NextResponse.json(p.normalize(result.data));
    }
    errors.push(`[${p.host}] ${result.error}`);
  }

  return NextResponse.json({ error: 'Weather API unavailable', details: errors }, { status: 502 });
}
