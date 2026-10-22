import { claimApprovalComment, getCheckRun, getRepo, reviewRunStore, updateApprovalComment } from './db.ts';
import { getInstallationOctokit } from './github.ts';
import { APP_BASE_URL } from './config.ts';

interface CommentTarget { checkId: number; identity: string; owner: string; repo: string; pr: number; sha: string; appId: number; }
const defaultStore = { claim: claimApprovalComment, update: updateApprovalComment };

// Runtime notification, not a review or an approval. The trusted binding is
// resolved below from PostgreSQL; neither PR text nor the browser picks a target.
export async function deliverApprovalComment(target: CommentTarget, octokit: any, store = defaultStore) {
  const claim = await store.claim(target.checkId, target.identity);
  if (!claim) return;
  const marker = `<!-- jean-ci-tool-approval:${claim.marker} -->`;
  const body = `### Reviewer tool approval required\n\nThe review is paused for an operator decision. [Open this review's authenticated check page](${APP_BASE_URL}/checks/${target.checkId}) to **Approve once** or **Deny**.\n\nReviewed SHA: \`${target.sha}\`. Native approval expiry still applies; this is not a code finding or a request for changes.\n\n${marker}`;
  const params = { owner: target.owner, repo: target.repo, request: { timeout: 5000 } };
  const ours = (comment: any) => comment?.performed_via_github_app?.id === target.appId && comment?.body === body && Number.isSafeInteger(comment?.id) && comment.id > 0;
  try {
    let id = claim.candidate_id ? Number(claim.candidate_id) : null;
    // Reconcile an ambiguous previous create before considering another write.
    // Only this app's exact marker/body is evidence, not arbitrary PR comments.
    if (!id && claim.uncertain) {
      for (let page = 1; ; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...params, issue_number: target.pr, per_page: 100, page });
        if (!Array.isArray(data)) throw new Error('Invalid comment list');
        const existing = data.find(ours);
        if (existing) { id = existing.id; break; }
        if (data.length < 100) break;
      }
      if (!id) return; // ambiguous delivery: never blindly create a duplicate
    }
    if (!id) {
      // Commit intent BEFORE the network side effect. On crash/transport loss a
      // later lease reconciles, it does not blindly repeat POST.
      await store.update(claim, { uncertain: true });
      let created;
      try {
        created = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...params, issue_number: target.pr, body });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 408) await store.update(claim, { uncertain: false });
        throw error;
      }
      if (!Number.isSafeInteger(created.data?.id) || created.data.id < 1) throw new Error('Invalid comment receipt');
      id = created.data.id;
      await store.update(claim, { candidateId: id! });
    }
    const { data: verified } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...params, comment_id: id });
    if (!ours(verified) || verified.id !== id) throw new Error('Comment readback did not match');
    await store.update(claim, { uncertain: false, commentId: id!, url: `https://github.com/${target.owner}/${target.repo}/pull/${target.pr}#issuecomment-${id}` });
  } catch {
    // Notification failure must neither approve a tool nor restart the review.
    // A later poll may retry definite refusals/readback; ambiguous POST only reconciles.
    console.warn('PR tool approval link could not be confirmed; notification identity retained');
  }
}

export async function postReviewApprovalComments(checkId: number) {
  try {
    const check = await getCheckRun(checkId);
    const appId = Number(process.env.GITHUB_APP_ID);
    if (!check || check.status === 'completed' || !Number.isSafeInteger(appId) || appId < 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(check.repo) || !/^[a-f0-9]{40,64}$/.test(check.head_sha || '')) return;
    const repository = await getRepo(check.repo);
    if (!repository) return;
    const octokit = await getInstallationOctokit(repository.installation_id);
    const [owner, repo] = check.repo.split('/');
    for (const binding of await reviewRunStore.get(checkId)) for (const prompt of binding.pending) {
      await deliverApprovalComment({ checkId, owner, repo, pr: check.pr_number, sha: check.head_sha!, appId,
        identity: `${binding.segment}:${binding.run_id}:${prompt.execution_generation}:${prompt.prompt_id}` }, octokit);
    }
  } catch { console.warn('PR tool approval notification unavailable'); }
}
