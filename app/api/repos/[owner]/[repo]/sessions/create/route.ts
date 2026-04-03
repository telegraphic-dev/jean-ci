import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo } from '@/lib/db';
import { createRepoFeatureSession } from '@/lib/repo-feature-sessions';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function POST(req: NextRequest, { params }: Params) {
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

  if (!repoData.feature_sessions_enabled) {
    return NextResponse.json({ error: 'Feature sessions are not enabled for this repository' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const branchName = typeof body?.branchName === 'string' ? body.branchName.trim() : '';

  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  try {
    const session = await createRepoFeatureSession({
      repoFullName: fullName,
      title,
      branchName: branchName || null,
    });
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create feature session';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
