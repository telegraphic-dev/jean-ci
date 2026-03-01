import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo, setRepoReviewEnabled } from '@/lib/db';

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
  const { pr_review_enabled } = await req.json();
  
  if (pr_review_enabled !== undefined) {
    await setRepoReviewEnabled(fullName, pr_review_enabled);
  }
  
  return NextResponse.json({ success: true });
}

// Keep PUT for backwards compatibility
export { PATCH as PUT };
