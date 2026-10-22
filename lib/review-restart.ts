import { claimReviewRestart, finishReviewRestart, getCheckRun, getRepo, reserveReviewRestart, reviewRunStore } from './db.ts';
import { hermesClient } from './hermes-runs.ts';
import { ApprovalError, isInterruptedRestart } from './review-approvals.ts';
import { getInstallationOctokit, getPRInfo } from './github.ts';
import { runPRReview } from './pr-review.ts';

const defaults = { getCheck: getCheckRun, getRepo, store: reviewRunStore, client: hermesClient,
  getInstallationOctokit, getPRInfo, reserve: reserveReviewRestart };
export async function restartReview(id: number, actor: string, deps = defaults) {
  if (!await deps.getCheck(id)) throw new ApprovalError(404, 'Check not found');
  const newId = await deps.reserve(id, actor, async check => {
    if (check.status !== 'completed' || !check.head_sha) throw new ApprovalError(409, 'Only a completed, interrupted approval review can be restarted');
    const bindings = await deps.store.get(id);
    if (!bindings.some(b => b.denied || b.pending.length || b.history?.some(h => ['expired', 'unconfirmed'].includes(h.outcome))) && !isInterruptedRestart(check)) throw new ApprovalError(409, 'This review has no expired or unconfirmed approval');
    const client = deps.client();
    for (const b of bindings) {
      if (!b.run_id || b.scope !== client.scope) throw new ApprovalError(409, 'Existing execution cannot be verified in this requester scope');
      const run = await deps.store.observe(b, () => client.status(b.run_id!));
      if (!['completed', 'failed', 'cancelled', 'interrupted', 'expired'].includes(run.status)) throw new ApprovalError(409, 'The original execution is still live or unknown; it cannot be restarted');
    }
    const repo = await deps.getRepo(check.repo);
    if (!repo?.pr_review_enabled) throw new ApprovalError(409, 'Repository review is disabled');
    const [owner, name] = check.repo.split('/');
    const pr = await deps.getPRInfo(await deps.getInstallationOctokit(repo.installation_id), owner, name, check.pr_number);
    if (pr.state !== 'open' || pr.head?.sha !== check.head_sha) throw new ApprovalError(409, 'PR closed or review head changed; request a review of the current head instead');
  });
  const reserved = await deps.getCheck(newId);
  if (!reserved) throw new ApprovalError(404, 'Reserved check not found');
  return { status: reserved.status, check_id: newId, url: `/checks/${newId}` };
}

// A committed queued request survives a crash before dispatch. A claimed request
// never dispatches twice; startup recovery marks interrupted executions incomplete.
export async function dispatchReviewRestart(sourceId: number) {
  const check = await claimReviewRestart(sourceId);
  if (!check) return;
  try {
    const repo = await getRepo(check.repo);
    if (!repo?.pr_review_enabled || !check.head_sha) throw new Error('Repository review disabled or head unavailable');
    const [owner, name] = check.repo.split('/');
    await runPRReview(repo.installation_id, owner, name, check.pr_number, check.head_sha, { checkId: check.id, checkName: check.check_name });
  } finally {
    // Also handles pre-GitHub-ID failures. If settlement fails, leave the claim
    // dispatching so startup reconciliation can atomically terminalize it later.
    await finishReviewRestart(sourceId);
  }
}
