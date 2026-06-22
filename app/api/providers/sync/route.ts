/**
 * POST /api/providers/sync
 *
 * Triggers a fresh RapidAPI subscription scan and updates the on-disk registry.
 * Call this whenever you want to detect newly subscribed APIs.
 *
 * Can be scheduled via:
 *   - AWS EventBridge Scheduler → Lambda → POST this endpoint
 *   - Vercel Cron (vercel.json crons)
 *   - A simple curl from any CI/CD pipeline
 *
 * Returns a diff: which APIs were newly detected vs previously known.
 */

import { NextRequest, NextResponse } from 'next/server';
import { scanAllHosts, invalidateRegistry, getRegistry } from '@/services/dynamic-registry';
import { getRapidApiKey } from '@/services/api-manager/key-vault';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const key = getRapidApiKey();
  if (!key) {
    return NextResponse.json({ ok: false, error: 'RAPIDAPI_KEY not configured' }, { status: 400 });
  }

  // Capture what was subscribed before
  const before = await getRegistry().catch(() => null);
  const beforeHosts = new Set((before?.entries ?? []).filter(e => e.subscribed).map(e => e.host));

  // Full rescan
  invalidateRegistry();
  const after = await scanAllHosts({ forceRefresh: true });

  // Compute diff
  const nowSubscribed = after.entries.filter(e => e.subscribed);
  const newlyFound = nowSubscribed.filter(e => !beforeHosts.has(e.host));
  const nowLost = before
    ? before.entries.filter(e => e.subscribed && !nowSubscribed.some(n => n.host === e.host))
    : [];

  return NextResponse.json({
    ok: true,
    scannedAt: after.scannedAt,
    keyPrefix: after.keyPrefix,
    totalProbed: after.totalProbed,
    totalSubscribed: after.totalSubscribed,
    categoriesAvailable: after.categoriesAvailable,
    diff: {
      newlySubscribed: newlyFound.map(e => ({ host: e.host, name: e.name, categories: e.categories })),
      noLongerSubscribed: nowLost.map(e => ({ host: e.host, name: e.name })),
      unchanged: after.totalSubscribed - newlyFound.length,
    },
    message: newlyFound.length > 0
      ? `Found ${newlyFound.length} new subscription(s): ${newlyFound.map(e => e.name).join(', ')}`
      : `No new subscriptions detected. Total: ${after.totalSubscribed}/${after.totalProbed}`,
  });
}

// GET for health-check / cron ping
export async function GET() {
  const key = getRapidApiKey();
  return NextResponse.json({
    ok: true,
    endpoint: '/api/providers/sync',
    keyConfigured: !!key,
    usage: 'POST to trigger a fresh subscription scan',
  });
}
