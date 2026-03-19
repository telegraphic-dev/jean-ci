import { NextRequest, NextResponse } from 'next/server';
import { getAllCheckRunsPaginated } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { page, limit } = parsePaginationParams(req, { defaultLimit: 50, maxLimit: 100 });
  const result = await getAllCheckRunsPaginated(page, limit);
  return NextResponse.json(result);
}
