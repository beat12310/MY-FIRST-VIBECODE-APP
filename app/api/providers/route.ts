/**
 * GET  /api/providers           — full provider status across all tiers
 * POST /api/providers           — { action: 'select', need: '...' } — select best provider
 *                                 { action: 'category', category: '...' } — list by category
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProviderStatus, selectProvider, allProvidersForCategory } from '@/services/provider-engine';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET() {
  const status = await getProviderStatus();
  return NextResponse.json({ ok: true, ...status });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, string>;

  if (body.action === 'select') {
    const need = body.need?.trim();
    if (!need) {
      return NextResponse.json({ error: 'Provide { action: "select", need: "..." }' }, { status: 400 });
    }
    const plan = await selectProvider({ need, category: body.category });
    return NextResponse.json({ ok: true, ...plan });
  }

  if (body.action === 'category') {
    const category = body.category?.trim();
    if (!category) {
      return NextResponse.json({ error: 'Provide { action: "category", category: "..." }' }, { status: 400 });
    }
    const providers = await allProvidersForCategory(category);
    return NextResponse.json({ ok: true, category, providers, count: providers.length });
  }

  return NextResponse.json(
    { error: 'Unknown action. Use "select" or "category".' },
    { status: 400 },
  );
}
