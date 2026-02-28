import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { setRepoReviewEnabled } from '@/lib/db';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ owner: string; repo: string }> }) {
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
