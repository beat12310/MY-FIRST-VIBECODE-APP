/**
 * POST /api/api-manager/proxy — convenience alias used by generated apps.
 *
 * Generated apps call /api/api-manager/proxy directly (without an action field)
 * because the path is more explicit. This handler accepts the same body as
 * the parent route's action=proxy handler and forwards to the same logic.
 *
 * Body: { projectId, category, params?, body?, method? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiManager } from '@/services/api-manager/index';

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const projectId = String(body.projectId || '');
  const category  = String(body.category  || '');
  const params    = (body.params || {}) as Record<string, string>;
  const bdy       = body.body;
  const method    = (body.method as 'GET' | 'POST' | undefined) || 'GET';

  if (!category) {
    return NextResponse.json({ error: 'Missing category' }, { status: 400 });
  }

  const result = await apiManager.proxyCall({ projectId, category, params, body: bdy, method });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, provider: result.provider },
      { status: 502 }
    );
  }

  return NextResponse.json(result.data);
}
