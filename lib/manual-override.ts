import { getCheckRun, getRepo, overrideCheckRunToPass, type CheckRun, type Repo } from './db.ts';
import { canCreateOverrideApproval, createPRReview, getInstallationOctokit, getPRInfo, updateCheck } from './github.ts';

export interface ManualOverrideSuccess {
  ok: true;
  checkRun: CheckRun;
  githubReviewSubmitted: boolean;
  githubCheckUpdated: boolean;
}

export interface ManualOverrideFailure {
  ok: false;
  status: number;
  error: string;
}

export type ManualOverrideResult = ManualOverrideSuccess | ManualOverrideFailure;

export interface ManualOverrideDeps {
  getCheckRun: typeof getCheckRun;
  getRepo: typeof getRepo;
  overrideCheckRunToPass: typeof overrideCheckRunToPass;
  getInstallationOctokit: typeof getInstallationOctokit;
  getPRInfo: typeof getPRInfo;
  createPRReview: typeof createPRReview;
  updateCheck: typeof updateCheck;
  canCreateOverrideApproval: typeof canCreateOverrideApproval;
}

const defaultDeps: ManualOverrideDeps = {
  getCheckRun,
  getRepo,
  overrideCheckRunToPass,
  getInstallationOctokit,
  getPRInfo,
  createPRReview,
  updateCheck,
  canCreateOverrideApproval,
};

function splitRepo(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function isGlobalReviewCheck(checkRun: CheckRun): boolean {
  return checkRun.check_name === 'Code Review';
}

function buildOverrideReviewBody(actor: string, reason: string, checkRunId: number): string {
  return [
    '## ✅ Manual override approval',
    '',
    `Recorded by **${actor}** in jean-ci admin.`,
    '',
    `**Reason:** ${reason}`,
    '',
    `*[View jean-ci audit trail](/checks/${checkRunId})*`,
  ].join('\n');
}

function buildOverrideCheckSummary(actor: string, reason: string, checkRunId: number): string {
  return [
    `Manual override recorded by ${actor}.`,
    '',
    `Reason: ${reason}`,
    '',
    `See jean-ci audit trail: /checks/${checkRunId}`,
  ].join('\n');
}

async function performManualOverrideWithDeps(
  checkId: number,
  reason: string,
  actor: string,
  deps: ManualOverrideDeps,
): Promise<ManualOverrideResult> {
  const sanitizedReason = reason.trim();
  if (!sanitizedReason) {
    return { ok: false, status: 400, error: 'Reason is required' };
  }

  const checkRun = await deps.getCheckRun(checkId);
  if (!checkRun) {
    return { ok: false, status: 404, error: 'Check run not found' };
  }

  if (checkRun.manually_overridden) {
    return { ok: false, status: 409, error: 'Check run was already overridden' };
  }

  if (checkRun.status !== 'completed' || checkRun.conclusion !== 'failure') {
    return { ok: false, status: 400, error: 'Only failed completed checks can be overridden' };
  }

  const repoConfig = await deps.getRepo(checkRun.repo);
  if (!repoConfig) {
    return { ok: false, status: 404, error: `Repository ${checkRun.repo} is not configured in jean-ci` };
  }

  const repoParts = splitRepo(checkRun.repo);
  if (!repoParts) {
    return { ok: false, status: 400, error: `Invalid repository name: ${checkRun.repo}` };
  }

  const { owner, repo } = repoParts;
  const octokit = await deps.getInstallationOctokit((repoConfig as Repo).installation_id);

  let githubReviewSubmitted = false;
  let githubCheckUpdated = false;

  if (isGlobalReviewCheck(checkRun)) {
    const prInfo = await deps.getPRInfo(octokit, owner, repo, checkRun.pr_number);
    const approvalCheck = deps.canCreateOverrideApproval(checkRun, prInfo);
    if (!approvalCheck.ok) {
      return { ok: false, status: 409, error: `Cannot override on GitHub: ${approvalCheck.reason}` };
    }

    await deps.createPRReview(
      octokit,
      owner,
      repo,
      checkRun.pr_number,
      'APPROVE',
      buildOverrideReviewBody(actor, sanitizedReason, checkRun.id),
    );
    githubReviewSubmitted = true;
  }

  if (checkRun.github_check_id) {
    await deps.updateCheck(octokit, owner, repo, checkRun.github_check_id, {
      status: 'completed',
      conclusion: 'success',
      completed_at: new Date().toISOString(),
      output: {
        title: '✅ Manually overridden',
        summary: buildOverrideCheckSummary(actor, sanitizedReason, checkRun.id),
      },
    });
    githubCheckUpdated = true;
  }

  const updated = await deps.overrideCheckRunToPass(checkId, sanitizedReason, actor);
  if (!updated) {
    return { ok: false, status: 409, error: 'Check run changed before override could be recorded' };
  }

  return {
    ok: true,
    checkRun: updated,
    githubReviewSubmitted,
    githubCheckUpdated,
  };
}

export async function performManualOverride(checkId: number, reason: string, actor: string): Promise<ManualOverrideResult> {
  return performManualOverrideWithDeps(checkId, reason, actor, defaultDeps);
}

export const __test__ = {
  performManualOverrideWithDeps,
};
