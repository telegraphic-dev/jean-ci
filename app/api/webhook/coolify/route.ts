import { NextRequest, NextResponse } from 'next/server';
import { getPendingDeployment, completePendingDeployment } from '@/lib/coolify';
import { getInstallationOctokit, updateDeploymentStatus, updateCheck } from '@/lib/github';
import { insertEvent, getRepoForApp, getLastDeploymentShaForApp, getPendingDeploymentByDeploymentUuid, getShaForDeploymentUuid } from '@/lib/db';
import { runSmokeTests } from '@/lib/smoke-tests';

export async function POST(req: NextRequest) {
  const payload = await req.json();
  
  console.log(`[Coolify] Event received:`, JSON.stringify(payload).substring(0, 500));
  
  const { event, message, application_uuid, deployment_url, application_name, deployment_uuid, task_uuid, task_name } = payload;
  const deploymentUuid = deployment_uuid || payload?.deploymentUuid || payload?.deployment_id || payload?.deploymentId;
  
  // Get pending deployment from database (for deployment events)
  // Try matching by deployment_uuid first (more precise), then fall back to app_uuid
  let pending = deploymentUuid ? await getPendingDeploymentByDeploymentUuid(String(deploymentUuid)) : null;
  if (!pending && application_uuid) {
    pending = await getPendingDeployment(application_uuid);
  }
  
  // Get repo from pending deployment OR from app mapping
  let actualRepo = pending ? `${pending.owner}/${pending.repo}` : null;
  if (!actualRepo && application_uuid) {
    actualRepo = await getRepoForApp(application_uuid);
  }
  
  // Get SHA from pending deployment, or look up from deployment_started event
  let headSha: string | undefined = pending?.head_sha;
  if (!headSha && deploymentUuid) {
    // Match by deployment_uuid - most reliable (handles duplicate deploys)
    headSha = (await getShaForDeploymentUuid(String(deploymentUuid))) ?? undefined;
  }
  if (!headSha && application_uuid) {
    // Fall back to most recent deployment for this app
    headSha = (await getLastDeploymentShaForApp(application_uuid)) ?? undefined;
  }
  
  // Use deployment_uuid or task_uuid+timestamp as delivery_id
  // Task events reuse the same task_uuid, so we need timestamp for uniqueness
  const deliveryId = deploymentUuid ? String(deploymentUuid) : (task_uuid ? `${task_uuid}-${Date.now()}` : null);
  
  // Store Coolify event in database with the actual repo
  await insertEvent(
    `coolify_${event || 'unknown'}`,
    deliveryId,
    actualRepo || application_name || null,
    event || null,
    {
      ...payload,
      _source_repo: actualRepo,
      _source_sha: headSha,
      _app_name: application_name,
      _task_name: task_name,
    },
    'coolify'
  );
  
  if (!application_uuid) {
    return NextResponse.json({ received: true, ignored: 'no app uuid' });
  }
  
  // Handle task events (no pending deployment expected)
  if (event === 'task_success' || event === 'task_failed') {
    console.log(`[Coolify] Task event: ${task_name || 'unknown'} → ${event} (app: ${application_uuid}, repo: ${actualRepo || 'unmapped'})`);
    return NextResponse.json({ 
      received: true, 
      event,
      task_name,
      repo: actualRepo,
    });
  }
  
  // For deployment events, we need a pending deployment
  if (!pending) {
    console.log(`[Coolify] No pending deployment for ${application_uuid} (event: ${event})`);
    return NextResponse.json({ received: true, event, ignored: 'no pending deployment' });
  }
  
  // Get Octokit for this installation
  const octokit = await getInstallationOctokit(pending.installation_id);
  const { owner, repo, deployment_id: deploymentId, check_run_id: checkRunId, app_url: appUrl, logs_url: pendingLogsUrl } = pending;
  const logsUrl = deployment_url || pendingLogsUrl;
  
  let ghState = 'in_progress';
  let description = message || 'Deploying...';
  let checkConclusion: string | null = null;
  
  if (event === 'deployment_success') {
    ghState = 'success';
    checkConclusion = 'success';
    description = message || 'Deployment successful';
    await completePendingDeployment(application_uuid);
    
    // Trigger smoke tests asynchronously (don't block webhook response)
    if (headSha) {
      runSmokeTests({
        owner,
        repo,
        head_sha: headSha,
        installation_id: pending.installation_id,
        app_url: appUrl,
        logs_url: logsUrl,
      }).catch(err => console.error('Smoke test error:', err));
    }
  } else if (event === 'deployment_failed') {
    ghState = 'failure';
    checkConclusion = 'failure';
    description = message || 'Deployment failed';
    await completePendingDeployment(application_uuid);
  } else {
    return NextResponse.json({ received: true, event });
  }
  
  if (deploymentId) {
    await updateDeploymentStatus(octokit, owner, repo, deploymentId, ghState, description, logsUrl, appUrl);
    console.log(`[Coolify] Updated GitHub deployment ${deploymentId} to ${ghState}`);
  }
  
  if (checkRunId) {
    await updateCheck(octokit, owner, repo, checkRunId, {
      status: 'completed',
      conclusion: checkConclusion,
      details_url: logsUrl,
      output: {
        title: checkConclusion === 'success' ? 'Deployment successful' : 'Deployment failed',
        summary: `${description}\n\n[View deployment](${appUrl}) | [View logs](${logsUrl})`,
      },
    });
    console.log(`[Coolify] Updated GitHub check ${checkRunId} to ${checkConclusion}`);
  }
  
  return NextResponse.json({ received: true, state: ghState });
}
