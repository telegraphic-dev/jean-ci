import { NextRequest, NextResponse } from 'next/server';
import { getRecentEventsPaginated } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { page, limit } = parsePaginationParams(req, { defaultLimit: 50, maxLimit: 100 });
  const url = new URL(req.url);
  const eventType = url.searchParams.get('eventType') || undefined;
  const repo = url.searchParams.get('repo') || undefined;
  const result = await getRecentEventsPaginated(page, limit, eventType, repo);
  return NextResponse.json(result);
}
