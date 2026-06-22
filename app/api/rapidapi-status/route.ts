/**
 * GET /api/rapidapi-status — returns catalog status + key configuration
 * POST /api/rapidapi-status — runs a test on one or all entries
 */

import { NextRequest, NextResponse } from 'next/server';
import { API_CATALOG, allCategories, getProviders, updateEntryStatus } from '@/services/api-catalog';
import { testProvider, isRapidApiConfigured, getRapidApiKey } from '@/services/rapidapi-connector';

export async function GET() {
  const keyConfigured = isRapidApiConfigured();
  const key = getRapidApiKey();

  const catalog = API_CATALOG.map(e => ({
    id: e.id,
    name: e.name,
    category: e.category,
    useCase: e.useCase,
    rapidApiHost: e.rapidApiHost,
    status: e.status,
    usageCount: e.usageCount,
    lastTestedAt: e.lastTestedAt,
    lastError: e.lastError,
    // Mask the key entirely — never send it to the browser
    hasKey: keyConfigured,
  }));

  const categories = allCategories().map(cat => ({
    category: cat,
    providers: getProviders(cat).map(e => e.id),
    workingProvider: getProviders(cat).find(e => e.status === 'working')?.id ?? null,
  }));

  return NextResponse.json({
    keyConfigured,
    keyPrefix: keyConfigured ? `${key.slice(0, 8)}…` : null,
    catalog,
    categories,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { entryId, testAll } = body as { entryId?: string; testAll?: boolean };

  const key = getRapidApiKey();
  if (!key) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY not configured in .env.local' }, { status: 400 });
  }

  if (testAll) {
    const results: Record<string, { ok: boolean; preview?: string; error?: string; ms?: number }> = {};

    for (const entry of API_CATALOG) {
      const result = await testProvider(entry, key);
      updateEntryStatus(entry.id, {
        status: result.ok ? 'working' : key ? 'failed' : 'needs_setup',
        error: result.error,
      });
      results[entry.id] = { ok: result.ok, preview: result.preview, error: result.error, ms: result.responseTime };
    }

    return NextResponse.json({ results });
  }

  if (entryId) {
    const entry = API_CATALOG.find(e => e.id === entryId);
    if (!entry) return NextResponse.json({ error: `Entry "${entryId}" not found` }, { status: 404 });

    const result = await testProvider(entry, key);
    updateEntryStatus(entry.id, {
      status: result.ok ? 'working' : 'failed',
      error: result.error,
    });
    return NextResponse.json({
      id: entryId,
      ok: result.ok,
      status: result.status,
      preview: result.preview,
      error: result.error,
      ms: result.responseTime,
    });
  }

  return NextResponse.json({ error: 'Provide entryId or testAll: true' }, { status: 400 });
}
