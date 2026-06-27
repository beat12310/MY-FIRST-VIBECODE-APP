/** GET /api/check-url?url=https://... — check if a URL returns HTTP 200 with Next.js headers */

import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return Response.json({ ok: false, error: 'Missing url param' }, { status: 400 });

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'DWOMOH-StatusCheck/1.0' },
    });
    clearTimeout(t);
    const body  = await res.text();
    const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '';
    return Response.json({
      ok:     res.status === 200 && body.length > 500,
      status: res.status,
      title,
      powered:  res.headers.get('x-powered-by')  ?? '',
      cache:    res.headers.get('x-nextjs-cache') ?? '',
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) });
  }
}
