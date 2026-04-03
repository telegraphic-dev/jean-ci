import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo, setRepoFeatureSessionsEnabled, setRepoReviewEnabled } from '@/lib/db';

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function GET(req: NextRequest, { params }: Params) {
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
  
  return NextResponse.json(repoData);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const body = await req.json();
  const { pr_review_enabled, feature_sessions_enabled } = body ?? {};

  if (pr_review_enabled !== undefined && typeof pr_review_enabled !== 'boolean') {
    return NextResponse.json({ error: 'pr_review_enabled must be a boolean' }, { status: 400 });
  }

  if (feature_sessions_enabled !== undefined && typeof feature_sessions_enabled !== 'boolean') {
    return NextResponse.json({ error: 'feature_sessions_enabled must be a boolean' }, { status: 400 });
  }
  
  if (pr_review_enabled !== undefined) {
    await setRepoReviewEnabled(fullName, pr_review_enabled);
  }

  if (feature_sessions_enabled !== undefined) {
    await setRepoFeatureSessionsEnabled(fullName, feature_sessions_enabled);
  }
  
  return NextResponse.json({ success: true });
}

// Keep PUT for backwards compatibility
export { PATCH as PUT };
