import { NextRequest, NextResponse } from 'next/server';
import { getEventsByRepoPaginated } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const { page, limit } = parsePaginationParams(req, { defaultLimit: 50, maxLimit: 100 });

  const result = await getEventsByRepoPaginated(fullName, page, limit);
  return NextResponse.json(result);
}
