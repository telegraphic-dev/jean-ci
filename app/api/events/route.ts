import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRecentEventsPaginated, getEventTypes } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const eventType = url.searchParams.get('eventType') || undefined;
  
  const result = await getRecentEventsPaginated(page, limit, eventType);
  return NextResponse.json(result);
}

export async function OPTIONS() {
  // Return available event types for the filter
  const types = await getEventTypes();
  return NextResponse.json({ types });
}
