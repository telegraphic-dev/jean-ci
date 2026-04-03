import { NextRequest, NextResponse } from 'next/server';
import { requirePublicApiToken } from '@/lib/public-api';
import { getRepo, getRepoFeatureSessions } from '@/lib/db';

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

  if (!repoData.feature_sessions_enabled) {
    return NextResponse.json({ error: 'Feature sessions are not enabled for this repository' }, { status: 404 });
  }

  const sessions = await getRepoFeatureSessions(fullName);
  return NextResponse.json(sessions);
}
