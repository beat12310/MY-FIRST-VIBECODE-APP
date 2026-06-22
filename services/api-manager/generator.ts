/**
 * API Manager — Integration Code Generator
 *
 * Produces ready-to-paste Next.js API route files for each category.
 * Generated routes call the DWOMOH platform proxy first (so RAPIDAPI_KEY
 * stays in the platform only), falling back to a direct call if the app
 * has its own credentials injected.
 *
 * Architecture:
 *   Frontend component
 *     → /api/integrations/[category]  (generated app's local route)
 *       → DWOMOH_PLATFORM_URL/api/api-manager/proxy  (platform proxy)
 *         → External API (RapidAPI, Stripe, etc.)
 */

export interface GeneratedRoute {
  path: string;       // relative path inside the generated project
  content: string;    // complete file content
}

/** Produces the proxy-first route for a given API category. */
export function generateIntegrationRoute(
  category: string,
  rapidApiHost: string,
  testEndpoint: string,
  testParams?: Record<string, string>,
): GeneratedRoute {
  const routeMap: Record<string, GeneratedRoute> = {
    video_downloader: generateTikTokRoute(rapidApiHost),
    weather: generateWeatherRoute(rapidApiHost),
    music: generateMusicRoute(rapidApiHost),
    sports: generateSportsRoute(rapidApiHost),
    finance: generateCurrencyRoute(rapidApiHost),
    news: generateNewsRoute(rapidApiHost),
    ai_tools: generateAiRoute(rapidApiHost),
  };

  return routeMap[category] ?? generateGenericRoute(category, rapidApiHost, testEndpoint, testParams);
}

/** Shared proxy-call helper — embeds platform URL reference. */
const proxyCall = (category: string, params: string) => `
  // ── 1. Try DWOMOH platform proxy (key stays on platform, never in this app) ──
  const platformUrl = process.env.DWOMOH_PLATFORM_URL || 'http://localhost:3000';
  const projectId = process.env.DWOMOH_PROJECT_ID || '';
  try {
    const proxyRes = await fetch(\`\${platformUrl}/api/api-manager/proxy\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, category: '${category}', params: ${params} }),
      signal: AbortSignal.timeout(15000),
    });
    if (proxyRes.ok) return NextResponse.json(await proxyRes.json());
  } catch { /* platform unavailable — fall through to direct call */ }`;

function generateTikTokRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/tiktok-download/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  if (!/tiktok\\.com/i.test(url)) return NextResponse.json({ error: 'URL must be a TikTok link' }, { status: 400 });
${proxyCall('video_downloader', '{ url }')}

  // ── 2. Direct RapidAPI call (requires RAPIDAPI_KEY in this app's .env.local) ──
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'API not configured. Connect via DWOMOH API Manager.' }, { status: 503 });

  const res = await fetch(\`https://${host}/video/info?url=\${encodeURIComponent(url)}\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return NextResponse.json({ error: \`Provider returned HTTP \${res.status}\` }, { status: 502 });

  const data = await res.json();
  const mp4Url = data?.data?.play || data?.data?.hdplay || data?.data?.wmplay;
  if (!mp4Url) return NextResponse.json({ error: 'Could not extract video URL from provider response' }, { status: 502 });

  // Stream the MP4 — only return binary, never JSON/HTML
  const videoRes = await fetch(mp4Url, { signal: AbortSignal.timeout(60000) });
  if (!videoRes.ok || !videoRes.body) return NextResponse.json({ error: 'Video stream failed' }, { status: 502 });

  return new Response(videoRes.body, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="tiktok-video.mp4"',
      'Cache-Control': 'no-store',
    },
  });
}
`,
  };
}

function generateWeatherRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/weather/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get('city') || searchParams.get('q') || 'London';
  const units = searchParams.get('units') || 'metric';
${proxyCall('weather', '{ city, units }')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'Weather API not configured.' }, { status: 503 });

  const res = await fetch(\`https://${host}/weather?q=\${encodeURIComponent(city)}&units=\${units}\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`Weather API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

function generateMusicRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/music-search/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const q = new URL(request.url).searchParams.get('q') || '';
  if (!q) return NextResponse.json({ error: 'Missing ?q= parameter' }, { status: 400 });
${proxyCall('music', '{ q }')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'Music API not configured.' }, { status: 503 });

  const res = await fetch(\`https://${host}/v1/search/multi?search_type=SONGS_ARTISTS&query=\${encodeURIComponent(q)}\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`Music API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

function generateSportsRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/sports/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'fixtures';
  const league = searchParams.get('league') || '39';
  const season = searchParams.get('season') || '2024';
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
${proxyCall('sports', '{ type, league, season, date }')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'Sports API not configured.' }, { status: 503 });

  const endpointMap: Record<string, string> = {
    live: 'fixtures?live=all',
    standings: \`standings?league=\${league}&season=\${season}\`,
    leagues: 'leagues?current=true',
    fixtures: \`fixtures?league=\${league}&season=\${season}&date=\${date}\`,
  };

  const res = await fetch(\`https://${host}/v3/\${endpointMap[type] ?? endpointMap.fixtures}\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`Sports API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

function generateCurrencyRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/currency/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const from = (searchParams.get('from') || 'USD').toUpperCase();
  const to = (searchParams.get('to') || 'GHS').toUpperCase();
  const amount = parseFloat(searchParams.get('amount') || '1');
${proxyCall('finance', '{ from, to, amount }')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'Currency API not configured.' }, { status: 503 });

  const res = await fetch(\`https://${host}/exchange?from=\${from}&to=\${to}&q=1.0\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`Currency API returned HTTP \${res.status}\` }, { status: 502 });
  const rate = await res.json();
  if (typeof rate !== 'number') return NextResponse.json({ error: 'Unexpected currency response shape' }, { status: 502 });
  return NextResponse.json({ from, to, rate, amount, result: rate * amount });
}
`,
  };
}

function generateNewsRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/news/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || 'world news';
  const count = searchParams.get('count') || '10';
${proxyCall('news', '{ q, count }')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: 'News API not configured.' }, { status: 503 });

  const res = await fetch(\`https://${host}/news/search?q=\${encodeURIComponent(q)}&mkt=en-US&count=\${count}&safeSearch=Off\`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}', 'X-BingApis-SDK': 'true' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`News API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

function generateAiRoute(host: string): GeneratedRoute {
  return {
    path: 'app/api/integrations/ai-chat/route.ts',
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const messages = body.messages || [{ role: 'user', content: 'Hello' }];
${proxyCall('ai_tools', '{ messages }')}

  const key = process.env.RAPIDAPI_KEY || process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: 'AI API not configured.' }, { status: 503 });

  const res = await fetch(\`https://${host}/conversationgpt4\`, {
    method: 'POST',
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system_prompt: '', temperature: 0.9, top_k: 5, top_p: 0.9, max_tokens: 256 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return NextResponse.json({ error: \`AI API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

function generateGenericRoute(
  category: string,
  host: string,
  testEndpoint: string,
  testParams?: Record<string, string>,
): GeneratedRoute {
  const paramStr = testParams ? Object.entries(testParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  return {
    path: `app/api/integrations/${category.replace(/_/g, '-')}/route.ts`,
    content: `import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
${proxyCall(category, 'params')}

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return NextResponse.json({ error: '${category} API not configured.' }, { status: 503 });

  const url = new URL('${testEndpoint}');
  // Default test params
  ${paramStr ? `url.search = '${paramStr}';` : '// Merge request params\n  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));'}

  const res = await fetch(url.toString(), {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': '${host}' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NextResponse.json({ error: \`API returned HTTP \${res.status}\` }, { status: 502 });
  return NextResponse.json(await res.json());
}
`,
  };
}

/** Generate .env.local additions for a set of API categories. */
export function generateEnvAdditions(
  categories: string[],
  platformPort: number,
  projectId: string,
): string[] {
  const lines = [
    '',
    '# DWOMOH API Manager — generated apps call the platform proxy for all external APIs',
    `DWOMOH_PLATFORM_URL=http://localhost:${platformPort}`,
    `DWOMOH_PROJECT_ID=${projectId}`,
  ];

  if (categories.length > 0) {
    lines.push('');
    lines.push(`# APIs configured for this project: ${categories.join(', ')}`);
    lines.push('# All external API calls go through the platform proxy — no separate key needed here.');
  }

  return lines;
}
