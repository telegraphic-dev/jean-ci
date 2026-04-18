import { NextRequest, NextResponse } from 'next/server';
import { requirePublicApiToken } from '@/lib/public-api';
import { getLocalReviewRunStatus } from '@/lib/local-review-runs';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const { runId } = await context.params;
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }

  const status = await getLocalReviewRunStatus(normalizedRunId);
  if (!status) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json(status);
}
