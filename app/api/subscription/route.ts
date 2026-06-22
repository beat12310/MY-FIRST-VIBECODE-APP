import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateSubscription } from '@/services/subscription';

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  try {
    const email = req.nextUrl.searchParams.get('email') ?? userId;
    const sub = await getOrCreateSubscription(userId, email);
    return NextResponse.json(sub);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
