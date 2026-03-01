import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOpenPRsFromEvents } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  try {
    // Get open PRs from stored webhook events (no GitHub API calls)
    const allPRs = await getOpenPRsFromEvents();
    
    // Paginate
    const total = allPRs.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const items = allPRs.slice(offset, offset + limit);
    
    return NextResponse.json({ items, total, page, limit, totalPages });
  } catch (error) {
    console.error('Failed to fetch PRs:', error);
    return NextResponse.json({ error: 'Failed to fetch PRs' }, { status: 500 });
  }
}
