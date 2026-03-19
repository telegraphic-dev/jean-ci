import { NextRequest, NextResponse } from 'next/server';
import { getCheckRunsByRepoCount, getDeploymentsByRepoCount, getEventsByRepoCount } from '@/lib/db';
import { requirePublicApiToken } from '@/lib/public-api';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;

  const [checks, deployments, events] = await Promise.all([
    getCheckRunsByRepoCount(fullName),
    getDeploymentsByRepoCount(fullName),
    getEventsByRepoCount(fullName),
  ]);

  return NextResponse.json({ checks, deployments, events });
}
