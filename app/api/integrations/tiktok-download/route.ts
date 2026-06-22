/**
 * Platform Integration: TikTok Video Downloader
 *
 * Accepts a TikTok URL, fetches the real MP4 via RapidAPI, validates it,
 * and streams it to the browser. Never saves JSON, HTML, or error pages as .mp4.
 *
 * Usage: GET /api/integrations/tiktok-download?url=<tiktok_url>
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyRapidApi, findWorkingProvider } from '@/services/rapidapi-connector';

const TIKTOK_PROVIDERS = [
  {
    host: 'tiktok-scraper7.p.rapidapi.com',
    url: 'https://tiktok-scraper7.p.rapidapi.com/video/info',
    paramKey: 'url',
    extractUrl: (data: unknown): string | null => {
      if (!data || typeof data !== 'object') return null;
      const d = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
      if (!d) return null;
      return (d.hdplay || d.play || d.wmplay || null) as string | null;
    },
  },
  {
    host: 'social-media-video-downloader.p.rapidapi.com',
    url: 'https://social-media-video-downloader.p.rapidapi.com/smvd/get/all',
    paramKey: 'url',
    extractUrl: (data: unknown): string | null => {
      if (!data || typeof data !== 'object') return null;
      const links = (data as Record<string, unknown>).links;
      if (!Array.isArray(links)) return null;
      const mp4 = links.find((l: Record<string, unknown>) =>
        typeof l.link === 'string' && (l.type === 'video/mp4' || String(l.link).includes('.mp4'))
      );
      return mp4 ? (mp4 as Record<string, unknown>).link as string : null;
    },
  },
  {
    host: 'all-media-downloader.p.rapidapi.com',
    url: 'https://all-media-downloader.p.rapidapi.com/download',
    paramKey: 'url',
    extractUrl: (data: unknown): string | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      const url = d.url || (Array.isArray(d.links) ? (d.links[0] as Record<string,unknown>)?.url : null);
      return typeof url === 'string' ? url : null;
    },
  },
];

// Check first 4 bytes for ftyp/MP4 signature
async function validateMp4(url: string): Promise<{ valid: boolean; size?: number; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Range: 'bytes=0-2048' },
    });
    clearTimeout(timer);
    if (!res.ok) return { valid: false, error: `Validation fetch returned HTTP ${res.status}` };

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('html') || contentType.includes('json')) {
      return { valid: false, error: `Bad content-type: ${contentType}` };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength < 8) return { valid: false, error: 'File too small to be a valid MP4' };

    const bytes = new Uint8Array(buf);
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const isValidMp4 = ftyp === 'ftyp' || ftyp === 'mdat' || ftyp === 'moov' || ftyp === 'free';
    if (!isValidMp4) {
      return { valid: false, error: `Not a valid MP4 (ftyp marker not found at offset 4; got "${ftyp}")` };
    }

    const cl = res.headers.get('content-range') || res.headers.get('content-length');
    const size = cl ? parseInt(cl.split('/').pop() || '0') : buf.byteLength;
    if (size < 10000) return { valid: false, error: 'File size too small to be a real video' };

    return { valid: true, size };
  } catch (err) {
    clearTimeout(timer);
    return { valid: false, error: err instanceof Error ? err.message : 'Validation failed' };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tikTokUrl = searchParams.get('url');

  if (!tikTokUrl) {
    return NextResponse.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }

  // Must be a TikTok URL
  if (!/tiktok\.com/i.test(tikTokUrl)) {
    return NextResponse.json({ error: 'URL must be a TikTok link (tiktok.com)' }, { status: 400 });
  }

  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    return NextResponse.json({
      error: 'RAPIDAPI_KEY is not configured. Add it to .env.local to enable TikTok downloads.',
    }, { status: 503 });
  }

  const errors: string[] = [];

  for (const provider of TIKTOK_PROVIDERS) {
    // Step 1: Fetch metadata from RapidAPI provider
    const metaResult = await proxyRapidApi({
      url: provider.url,
      host: provider.host,
      params: { [provider.paramKey]: tikTokUrl },
    });

    if (!metaResult.ok) {
      errors.push(`[${provider.host}] ${metaResult.error}`);
      continue;
    }

    // Step 2: Extract MP4 URL from provider response
    const mp4Url = provider.extractUrl(metaResult.data);
    if (!mp4Url) {
      errors.push(`[${provider.host}] Could not extract MP4 URL from response`);
      continue;
    }

    // Step 3: Validate the MP4 (check signature, not empty, not HTML)
    const validation = await validateMp4(mp4Url);
    if (!validation.valid) {
      errors.push(`[${provider.host}] MP4 validation failed: ${validation.error}`);
      continue;
    }

    // Step 4: Stream the validated MP4 to the browser
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const videoRes = await fetch(mp4Url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!videoRes.ok || !videoRes.body) {
        errors.push(`[${provider.host}] Video fetch failed: HTTP ${videoRes.status}`);
        continue;
      }

      // Stream directly to the client
      return new Response(videoRes.body, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="tiktok-video.mp4"',
          'Cache-Control': 'no-store',
          ...(videoRes.headers.get('content-length')
            ? { 'Content-Length': videoRes.headers.get('content-length')! }
            : {}),
        },
      });
    } catch (err) {
      clearTimeout(timer);
      errors.push(`[${provider.host}] Stream error: ${err instanceof Error ? err.message : 'unknown'}`);
      continue;
    }
  }

  // All providers failed
  return NextResponse.json({
    error: 'Missing external API: TikTok Downloader API. All providers failed or are not available with the current key.',
    details: errors,
  }, { status: 502 });
}
