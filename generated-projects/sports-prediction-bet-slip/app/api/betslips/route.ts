/**
 * GET  /api/betslips  — list authenticated user's bet slips
 * POST /api/betslips  — create a new bet slip
 *
 * Requires Bearer token or managed_token cookie from /api/auth/login.
 * Returns HTTP 401 if no valid token is provided.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/managed/auth';

interface SlipMatch {
  match_id: string;
  prediction_id?: string;
  selection: string;
  odds: number;
}

interface BetSlip {
  id: string;
  user_id: string;
  name: string;
  matches: SlipMatch[];
  bet_type: string;
  total_odds: number;
  stake?: number;
  potential_return?: number;
  status: 'open' | 'won' | 'lost' | 'void';
  created_at: string;
  updated_at: string;
}

// In-memory store — persists for the lifetime of the process.
// Replace with SQLite (lib/managed/db) for persistent storage across restarts.
const betSlips: BetSlip[] = [];

export async function GET(request: NextRequest) {
  const auth = await getAuthUser(request);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized — provide a Bearer token or managed_token cookie' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get('status') || '';

  let results = betSlips.filter(slip => slip.user_id === auth.sub);
  if (statusFilter) {
    results = results.filter(slip => slip.status === statusFilter);
  }

  return NextResponse.json({ betslips: results, total: results.length });
}

export async function POST(request: NextRequest) {
  const auth = await getAuthUser(request);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized — provide a Bearer token or managed_token cookie' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, matches, bet_type, stake } = body as {
    name?: string;
    matches?: SlipMatch[];
    bet_type?: string;
    stake?: number;
  };

  if (!name || !matches || matches.length === 0 || !bet_type) {
    return NextResponse.json(
      { error: 'Required: name (string), matches (array with ≥1 item), bet_type (string)' },
      { status: 400 },
    );
  }

  // Validate each match entry
  for (const m of matches) {
    if (!m.match_id || !m.selection || typeof m.odds !== 'number' || m.odds <= 1) {
      return NextResponse.json(
        { error: 'Each match requires: match_id, selection, and odds > 1.0' },
        { status: 400 },
      );
    }
  }

  const total_odds    = matches.reduce((acc, m) => acc * m.odds, 1);
  const potential_return = stake ? parseFloat((stake * total_odds).toFixed(2)) : undefined;

  const slip: BetSlip = {
    id: `slip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user_id: auth.sub,
    name: String(name),
    matches,
    bet_type: String(bet_type),
    total_odds: parseFloat(total_odds.toFixed(4)),
    stake: stake ? Number(stake) : undefined,
    potential_return,
    status: 'open',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  betSlips.push(slip);

  return NextResponse.json({ betslip: slip }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await getAuthUser(request);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Provide ?id=<slip-id>' }, { status: 400 });

  const slip = betSlips.find(s => s.id === id && s.user_id === auth.sub);
  if (!slip) return NextResponse.json({ error: 'Bet slip not found' }, { status: 404 });

  const body = await request.json().catch(() => ({})) as Partial<BetSlip>;
  if (body.status && ['open', 'won', 'lost', 'void'].includes(body.status)) {
    slip.status = body.status;
    slip.updated_at = new Date().toISOString();
  }

  return NextResponse.json({ betslip: slip });
}
