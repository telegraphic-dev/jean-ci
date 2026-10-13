import type { CheckRun, Repo } from './db.ts';

export type InterruptedCheckRecoveryDeps = {
  listInterruptedChecks: (startedBefore: Date) => Promise<CheckRun[]>;
  getRepo: (repo: string) => Promise<Repo | null>;
  getInstallationOctokit: (installationId: number) => Promise<any>;
  completeGitHubCheck: (octokit: any, owner: string, repo: string, checkRunId: number, updates: any) => Promise<unknown>;
  markCheckCompleted: (id: number, data: {
    status: string;
    conclusion: string;
    title: string;
    summary: string;
    completed_at: Date;
  }) => Promise<unknown>;
  detailsUrl: (id: number) => string;
  log?: (message: string) => void;
};

export async function recoverInterruptedChecks(
  deps: InterruptedCheckRecoveryDeps,
  startedBefore = new Date(),
): Promise<{ recovered: number; skipped: number; failed: number }> {
  const checks = await deps.listInterruptedChecks(startedBefore);
  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const check of checks) {
    const checkRunId = check.github_check_id;
    const [owner, repo] = check.repo.split('/');
    const repoConfig = await deps.getRepo(check.repo);

    if (!checkRunId || !owner || !repo || !repoConfig) {
      skipped += 1;
      deps.log?.(`Skipping interrupted check ${check.id}: missing GitHub check or repository installation`);
      continue;
    }

    const title = '⚠️ Review interrupted by restart';
    const summary = 'jean-ci restarted while this check was running. The result was not produced; re-request the check or push a new commit to run a fresh review.';
    const completedAt = new Date();

    try {
      const octokit = await deps.getInstallationOctokit(repoConfig.installation_id);
      await deps.completeGitHubCheck(octokit, owner, repo, checkRunId, {
        status: 'completed',
        conclusion: 'neutral',
        completed_at: completedAt.toISOString(),
        details_url: deps.detailsUrl(check.id),
        output: { title, summary },
      });
      await deps.markCheckCompleted(check.id, {
        status: 'completed',
        conclusion: 'neutral',
        title,
        summary,
        completed_at: completedAt,
      });
      recovered += 1;
      deps.log?.(`Recovered interrupted check ${check.id} for ${check.repo}#${check.pr_number}`);
    } catch (error: any) {
      failed += 1;
      deps.log?.(`Failed to recover interrupted check ${check.id}: ${error.message}`);
    }
  }

  return { recovered, skipped, failed };
}
