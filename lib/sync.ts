import { 
  getAllPendingDeployments, 
  deletePendingDeployment,
  getReposWithPRReviewEnabled,
  cleanupOldEvents,
  getAllPRReviewsForRepo,
  deletePRReview
} from './db';
import { getInstallationOctokit } from './github';
import { COOLIFY_URL } from './config';
import { logExternalCallFailure, readResponseBodySnippet } from './external-call-logging.js';

const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN;

// Pending deployments older than this are considered stale
const STALE_DEPLOYMENT_MINUTES = 30;

interface SyncResult {
  stalePendingDeployments: number;
  closedPRs: number;
  coolifyDeploymentsChecked: number;
  oldEventsCleanedUp: number;
  errors: string[];
}

/**
 * Check Coolify for deployment status and clean up completed/failed ones
 */
async function syncPendingDeployments(): Promise<{ cleaned: number; errors: string[] }> {
  const errors: string[] = [];
  let cleaned = 0;
  
  const pending = await getAllPendingDeployments();
  console.log(`[Sync] Checking ${pending.length} pending deployments...`);
  
  for (const pd of pending) {
    try {
      // Check if deployment is stale (older than threshold)
      const createdAt = new Date(pd.created_at!).getTime();
      const ageMinutes = (Date.now() - createdAt) / 1000 / 60;
      
      if (ageMinutes > STALE_DEPLOYMENT_MINUTES) {
        console.log(`[Sync] Cleaning stale pending deployment for ${pd.app_uuid} (${Math.round(ageMinutes)}min old)`);
        await deletePendingDeployment(pd.app_uuid);
        cleaned++;
        continue;
      }
      
      // If we have deployment UUID, check Coolify for status
      if (pd.coolify_deployment_uuid && COOLIFY_TOKEN && COOLIFY_URL) {
        const url = `${COOLIFY_URL}/api/v1/deployments/${pd.coolify_deployment_uuid}`;
        let response: Response;
        try {
          response = await fetch(url, { headers: { 'Authorization': `Bearer ${COOLIFY_TOKEN}` } });
        } catch (error) {
          logExternalCallFailure({
            service: 'coolify',
            operation: 'sync.pending_deployments.fetch_status',
            url,
            method: 'GET',
            phase: 'transport',
            error,
          });
          throw error;
        }
        
        if (response.ok) {
          const data = await response.json();
          // If deployment is finished (success or failed), clean up
          if (data.status === 'finished' || data.status === 'failed' || data.status === 'cancelled') {
            console.log(`[Sync] Cleaning completed deployment ${pd.coolify_deployment_uuid} (status: ${data.status})`);
            await deletePendingDeployment(pd.app_uuid);
            cleaned++;
          }
        } else if (response.status === 404) {
          // Deployment not found in Coolify - clean up
          console.log(`[Sync] Cleaning orphaned pending deployment ${pd.coolify_deployment_uuid} (not found in Coolify)`);
          await deletePendingDeployment(pd.app_uuid);
          cleaned++;
        } else {
          const responseBody = await readResponseBodySnippet(response);
          logExternalCallFailure({
            service: 'coolify',
            operation: 'sync.pending_deployments.fetch_status',
            url,
            method: 'GET',
            phase: 'remote_response',
            status: response.status,
            responseBody,
          });
        }
      }
    } catch (e: any) {
      errors.push(`Error syncing deployment ${pd.app_uuid}: ${e.message}`);
    }
  }
  
  return { cleaned, errors };
}

/**
 * Check GitHub for closed PRs and update our records
 */
async function syncClosedPRs(): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;
  
  // Get repos with PR review enabled
  const repos = await getReposWithPRReviewEnabled();
  console.log(`[Sync] Checking PRs for ${repos.length} repos...`);
  
  for (const repo of repos) {
    try {
      const octokit = await getInstallationOctokit(repo.installation_id);
      const [owner, repoName] = repo.full_name.split('/');
      
      // Get open PRs from our database that might be closed in GitHub
      const prReviews = await getAllPRReviewsForRepo(repo.full_name);
      
      for (const row of prReviews) {
        try {
          const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: row.pr_number,
          });
          
          if (pr.state === 'closed') {
            // PR is closed, remove from our tracking
            await deletePRReview(repo.full_name, row.pr_number);
            console.log(`[Sync] Cleaned closed PR ${repo.full_name}#${row.pr_number}`);
            closed++;
          }
        } catch (e: any) {
          if (e.status !== 404) {
            errors.push(`Error checking PR ${repo.full_name}#${row.pr_number}: ${e.message}`);
          } else {
            // PR not found - clean up
            await deletePRReview(repo.full_name, row.pr_number);
            closed++;
          }
        }
      }
    } catch (e: any) {
      errors.push(`Error syncing PRs for ${repo.full_name}: ${e.message}`);
    }
  }
  
  return { closed, errors };
}

/**
 * Main sync function - runs all cleanup tasks
 */
export async function runSync(): Promise<SyncResult> {
  console.log('[Sync] Starting sync job...');
  const startTime = Date.now();
  
  const [deploymentResult, prResult, eventsCleanedUp] = await Promise.all([
    syncPendingDeployments(),
    syncClosedPRs(),
    cleanupOldEvents(),
  ]);
  
  const result: SyncResult = {
    stalePendingDeployments: deploymentResult.cleaned,
    closedPRs: prResult.closed,
    coolifyDeploymentsChecked: deploymentResult.cleaned,
    oldEventsCleanedUp: eventsCleanedUp,
    errors: [...deploymentResult.errors, ...prResult.errors],
  };
  
  const duration = Date.now() - startTime;
  console.log(`[Sync] Completed in ${duration}ms:`, {
    stalePendingDeployments: result.stalePendingDeployments,
    closedPRs: result.closedPRs,
    oldEventsCleanedUp: result.oldEventsCleanedUp,
    errors: result.errors.length,
  });
  
  return result;
}
