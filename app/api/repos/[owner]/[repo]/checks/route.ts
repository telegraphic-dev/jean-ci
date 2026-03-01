import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCheckRunsByRepoPaginated } from '@/lib/db';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  
  const result = await getCheckRunsByRepoPaginated(fullName, page, limit);
  return NextResponse.json(result);
}
