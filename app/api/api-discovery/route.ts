/**
 * GET  /api/api-discovery              — return cached registry (scan if cold)
 * POST /api/api-discovery { action: 'scan' }  — force full rescan
 * POST /api/api-discovery { action: 'find', prompt: '...' } — keyword match
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRegistry, scanAllHosts, invalidateRegistry, findBestForPrompt } from '@/services/dynamic-registry';
import { getRapidApiKey } from '@/services/api-manager/key-vault';

export const runtime = 'nodejs';
export const maxDuration = 120; // full scan of 150+ hosts can take ~60s

export async function GET() {
  const key = getRapidApiKey();
  if (!key) {
    return NextResponse.json({
      ok: false,
      keyConfigured: false,
      error: 'RAPIDAPI_KEY is not set. Add it to .env.local and restart the dev server.',
    });
  }

  const registry = await getRegistry();
  return NextResponse.json({
    ok: true,
    keyConfigured: true,
    ...registry,
  });
}

export async function POST(request: NextRequest) {
  const key = getRapidApiKey();
  if (!key) {
    return NextResponse.json({ ok: false, error: 'RAPIDAPI_KEY not configured.' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, string>;

  if (body.action === 'scan') {
    invalidateRegistry();
    const registry = await scanAllHosts({ forceRefresh: true });
    return NextResponse.json({
      ok: true,
      keyConfigured: true,
      message: `Scan complete — ${registry.totalSubscribed}/${registry.totalProbed} subscribed`,
      ...registry,
    });
  }

  if (body.action === 'find') {
    const prompt = body.prompt?.trim();
    if (!prompt) {
      return NextResponse.json({ error: 'Provide { action: "find", prompt: "..." }' }, { status: 400 });
    }
    // Ensure registry is loaded so findBestForPrompt has data
    await getRegistry();
    const matched = findBestForPrompt(prompt);
    return NextResponse.json({
      ok: true,
      prompt,
      matched: matched.map(e => ({
        host: e.host,
        name: e.name,
        categories: e.categories,
        description: e.description,
        httpStatus: e.httpStatus,
        responseMs: e.responseMs,
      })),
      count: matched.length,
    });
  }

  return NextResponse.json(
    { error: 'Unknown action. Use { action: "scan" } or { action: "find", prompt: "..." }.' },
    { status: 400 },
  );
}
