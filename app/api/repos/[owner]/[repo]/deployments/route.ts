import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDeploymentsByRepo } from '@/lib/db';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  
  const deployments = await getDeploymentsByRepo(fullName);
  return NextResponse.json(deployments);
}
