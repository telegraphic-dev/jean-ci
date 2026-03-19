import { NextRequest, NextResponse } from 'next/server';
import { getReposWithActivity } from '@/lib/db';
import { requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const repos = await getReposWithActivity();
  return NextResponse.json({ items: repos, total: repos.length });
}
