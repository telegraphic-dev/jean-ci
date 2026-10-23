import type { PendingDeployment } from './db.ts';

export type CoolifyConclusion = 'success' | 'failure' | 'cancelled';

export function coolifyStatusConclusion(status: unknown): CoolifyConclusion | null {
  if (status === 'finished') return 'success';
  if (status === 'failed') return 'failure';
  if (status === 'cancelled-by-user') return 'cancelled';
  return null;
}

// A delayed/foreign/preview webhook must never finish the current app deployment.
export function matchesCoolifyDeployment(pending: PendingDeployment, appUuid: unknown, deploymentUuid: unknown): boolean {
  return pending.app_uuid === appUuid && typeof deploymentUuid === 'string'
    && !!pending.coolify_deployment_uuid && pending.coolify_deployment_uuid === deploymentUuid;
}

interface CompletionDependencies {
  getInstallationOctokit: (installationId: number) => Promise<any>;
  updateDeploymentStatus: (...args: any[]) => Promise<any>;
  updateCheck: (...args: any[]) => Promise<any>;
  deletePendingDeployment: (appUuid: string, deploymentUuid?: string) => Promise<void>;
  runSmokeTests: (args: any) => Promise<any>;
}

// Shared by webhooks and polling. Keep the durable receipt until GitHub accepts
// both updates so a transient failure can be retried by the next poll.
export async function finishCoolifyDeployment(
  pending: PendingDeployment,
  conclusion: CoolifyConclusion,
  dependencies: CompletionDependencies,
  logsUrl = pending.logs_url,
  description = conclusion === 'success' ? 'Deployment successful' : conclusion === 'cancelled' ? 'Deployment cancelled' : 'Deployment failed',
): Promise<void> {
  const octokit = await dependencies.getInstallationOctokit(pending.installation_id);
  if (pending.deployment_id) {
    await dependencies.updateDeploymentStatus(octokit, pending.owner, pending.repo, pending.deployment_id,
      conclusion === 'success' ? 'success' : 'failure', description, logsUrl, pending.app_url, true);
  }
  if (pending.check_run_id) {
    await dependencies.updateCheck(octokit, pending.owner, pending.repo, pending.check_run_id, {
      status: 'completed', conclusion, details_url: logsUrl,
      output: { title: description, summary: `${description}\n\n[View deployment](${pending.app_url}) | [View logs](${logsUrl})` },
    });
  }
  await dependencies.deletePendingDeployment(pending.app_uuid, pending.coolify_deployment_uuid);
  if (conclusion === 'success' && pending.head_sha) {
    // Smoke-test scheduling is best-effort and must not undo deployment settlement.
    dependencies.runSmokeTests({ owner: pending.owner, repo: pending.repo, head_sha: pending.head_sha,
      installation_id: pending.installation_id, app_url: pending.app_url, logs_url: logsUrl,
    }).catch(error => console.error('Smoke test error:', error));
  }
}
