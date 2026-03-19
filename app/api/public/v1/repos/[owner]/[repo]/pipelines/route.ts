import { NextRequest, NextResponse } from 'next/server';
import { getDeploymentPipelinesByRepo } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const { page, limit } = parsePaginationParams(req, { defaultLimit: 20, maxLimit: 50 });

  const result = await getDeploymentPipelinesByRepo(fullName, page, limit);
  return NextResponse.json(result);
}
