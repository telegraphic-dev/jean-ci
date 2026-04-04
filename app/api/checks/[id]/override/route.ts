import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCheckRun, overrideCheckRunToPass } from '@/lib/db';

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

  const checkRun = await getCheckRun(checkId);
  if (!checkRun) {
    return NextResponse.json({ error: 'Check run not found' }, { status: 404 });
  }

  if (checkRun.manually_overridden) {
    return NextResponse.json({ error: 'Check run was already overridden' }, { status: 409 });
  }

  if (checkRun.status !== 'completed' || checkRun.conclusion !== 'failure') {
    return NextResponse.json({ error: 'Only failed completed checks can be overridden' }, { status: 400 });
  }

  const actor = auth.user?.login || `github:${auth.user?.id || 'admin'}`;

  const updated = await overrideCheckRunToPass(checkId, reason, actor);
  if (!updated) {
    return NextResponse.json({ error: 'Check run changed before override could be recorded' }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    checkRun: updated,
    warning: 'Manual override is recorded in jean-ci only. It does not update the GitHub check run or submit a GitHub approval review.',
  });
}
