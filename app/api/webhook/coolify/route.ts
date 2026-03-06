import { NextRequest, NextResponse } from 'next/server';
import { getPendingDeployment, completePendingDeployment } from '@/lib/coolify';
import { getInstallationOctokit, updateDeploymentStatus, updateCheck } from '@/lib/github';
import { insertEvent } from '@/lib/db';
import { runSmokeTests } from '@/lib/smoke-tests';

export async function POST(req: NextRequest) {
  const payload = await req.json();
  
  console.log(`[Coolify] Event received:`, JSON.stringify(payload).substring(0, 500));
  
  const { event, message, application_uuid, deployment_url, application_name, deployment_uuid } = payload;
  
  // Get pending deployment from database
  const pending = application_uuid ? await getPendingDeployment(application_uuid) : null;
  const actualRepo = pending ? `${pending.owner}/${pending.repo}` : null;
  const headSha = pending?.head_sha;
  
  // Store Coolify event in database with the actual repo that triggered the deploy
  // Use event:uuid as delivery_id to avoid unique constraint conflicts (same uuid for started/success)
  const deliveryId = deployment_uuid ? `${event}:${deployment_uuid}` : null;
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
    },
    'coolify'
  );
  
  if (!application_uuid) {
    return NextResponse.json({ received: true, ignored: 'no app uuid' });
  }
  
  if (!pending) {
    console.log(`[Coolify] No pending deployment for ${application_uuid}`);
    return NextResponse.json({ received: true, ignored: 'no pending deployment' });
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
