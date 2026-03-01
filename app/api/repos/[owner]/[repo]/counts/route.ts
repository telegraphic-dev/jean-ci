import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCheckRunsByRepoCount, getDeploymentsByRepoCount, getEventsByRepoCount } from '@/lib/db';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
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
