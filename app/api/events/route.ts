import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRecentEvents } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
  const repo = searchParams.get('repo');
  
  let events = await getRecentEvents(limit);
  
  // Filter by repo if specified
  if (repo) {
    events = events.filter((e: any) => e.repo === repo);
  }
  
  return NextResponse.json(events);
}
