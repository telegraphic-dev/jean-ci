import { NextRequest, NextResponse } from 'next/server';
import { getPendingDeployment } from '@/lib/coolify';
import { finishCoolifyDeployment, matchesCoolifyDeployment } from '@/lib/coolify-completion';
import { getInstallationOctokit, updateDeploymentStatus, updateCheck } from '@/lib/github';
import { insertEvent, deletePendingDeployment, getRepoForApp, getLastDeploymentShaForApp, getPendingDeploymentByDeploymentUuid, getShaForDeploymentUuid } from '@/lib/db';
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
  
  // Use event-scoped delivery IDs. Coolify reuses deployment_uuid across lifecycle events
  // (started/success/failed), so plain deployment_uuid would dedupe success as a duplicate.
  const deliveryId = deploymentUuid
    ? `${event || 'unknown'}:${String(deploymentUuid)}`
    : (task_uuid ? `${event || 'task'}:${task_uuid}-${Date.now()}` : null);
  
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
  
  if (!matchesCoolifyDeployment(pending, application_uuid, deploymentUuid) || payload.pull_request_id) {
    return NextResponse.json({ received: true, ignored: 'deployment identity mismatch' });
  }
  const conclusion = event === 'deployment_success' ? 'success' : event === 'deployment_failed' ? 'failure' : null;
  if (!conclusion) return NextResponse.json({ received: true, event });
  await finishCoolifyDeployment(pending, conclusion, {
    getInstallationOctokit, updateDeploymentStatus, updateCheck, deletePendingDeployment, runSmokeTests,
  }, deployment_url || pending.logs_url, message || undefined);
  return NextResponse.json({ received: true, state: conclusion });
}
