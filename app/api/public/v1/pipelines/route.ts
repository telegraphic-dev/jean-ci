import { NextRequest, NextResponse } from 'next/server';
import { getDeploymentPipelines } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { page, limit } = parsePaginationParams(req, { defaultLimit: 20, maxLimit: 50 });
  const result = await getDeploymentPipelines(page, limit);
  return NextResponse.json(result);
}
