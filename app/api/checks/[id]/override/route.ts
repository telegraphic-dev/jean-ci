import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCheckRun, getRepo, overrideCheckRunToPassTransaction } from '@/lib/db';
import { canCreateOverrideApproval, createPRReview, getInstallationOctokit, getPRInfo, updateCheck } from '@/lib/github';

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

  const repoConfig = await getRepo(checkRun.repo);
  if (!repoConfig) {
    return NextResponse.json({ error: 'Repository config not found' }, { status: 404 });
  }

  const [owner, repo] = checkRun.repo.split('/');
  if (!owner || !repo) {
    return NextResponse.json({ error: 'Invalid repository name' }, { status: 500 });
  }

  const actor = auth.user?.login || `github:${auth.user?.id || 'admin'}`;

  try {
    const octokit = await getInstallationOctokit(repoConfig.installation_id);

    const { checkRun: updated } = await overrideCheckRunToPassTransaction(
      checkId,
      reason,
      actor,
      async (lockedCheckRun) => {
        if (lockedCheckRun.github_check_id) {
          await updateCheck(octokit, owner, repo, lockedCheckRun.github_check_id, {
            status: 'completed',
            conclusion: 'success',
            completed_at: new Date().toISOString(),
            output: {
              title: '✅ Manually overridden to pass',
              summary: `Manual override applied by ${actor}.\n\nReason: ${reason}`,
            },
          });
        }

        if (lockedCheckRun.check_name === 'Code Review') {
          const prInfo = await getPRInfo(octokit, owner, repo, lockedCheckRun.pr_number);
          const reviewEligibility = canCreateOverrideApproval(lockedCheckRun, prInfo);
          if (!reviewEligibility.ok) {
            throw new Error(`Cannot create override approval: ${reviewEligibility.reason}`);
          }

          await createPRReview(
            octokit,
            owner,
            repo,
            lockedCheckRun.pr_number,
            'APPROVE',
            `## Manual override\n\nThis jean-ci review was manually overridden to pass by @${actor}.\n\nReason: ${reason}`,
          );
        }
      }
    );

    return NextResponse.json({ ok: true, checkRun: updated });
  } catch (error: any) {
    console.error('Failed to sync manual override to GitHub:', error.message);

    const message = error?.message || 'Override failed';
    const status = message === 'Check run not found'
      ? 404
      : message === 'Check run was already overridden'
        ? 409
        : message === 'Only failed completed checks can be overridden'
          ? 400
          : 502;

    return NextResponse.json({
      error: message,
    }, { status });
  }
}
