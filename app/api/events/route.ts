import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRecentEventsPaginated } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const repo = url.searchParams.get('repo');
  
  // If repo filter is specified, we need different logic
  // For now, just return all events paginated
  const result = await getRecentEventsPaginated(page, limit);
  return NextResponse.json(result);
}
