import { NextRequest, NextResponse } from 'next/server';
import { getRepo } from '@/lib/db';
import { requirePublicApiToken } from '@/lib/public-api';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;

  const repoData = await getRepo(fullName);

  if (!repoData) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  return NextResponse.json(repoData);
}
