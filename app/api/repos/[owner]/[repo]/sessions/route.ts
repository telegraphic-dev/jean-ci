import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo, getRepoFeatureSessions } from '@/lib/db';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(_req: Request, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;

  const repoData = await getRepo(fullName);
  if (!repoData) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  const sessions = await getRepoFeatureSessions(fullName);
  return NextResponse.json(sessions);
}
