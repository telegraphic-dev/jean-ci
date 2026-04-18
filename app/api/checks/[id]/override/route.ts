import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { performManualOverride } from '@/lib/manual-override';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id } = await params;
  const checkId = parseInt(id, 10);
  if (!Number.isFinite(checkId)) {
    return NextResponse.json({ error: 'Invalid check id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  const actor = auth.user?.login || `github:${auth.user?.id || 'admin'}`;

  const result = await performManualOverride(checkId, reason, actor);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    checkRun: result.checkRun,
    githubReviewSubmitted: result.githubReviewSubmitted,
    githubCheckUpdated: result.githubCheckUpdated,
  });
}
