import { NextRequest, NextResponse } from 'next/server';
import { pendingDeployments } from '@/lib/coolify';
import { updateDeploymentStatus, updateCheck } from '@/lib/github';
import { insertEvent } from '@/lib/db';

export async function POST(req: NextRequest) {
  const payload = await req.json();
  
  console.log(`[Coolify] Event received:`, JSON.stringify(payload).substring(0, 500));
  
  const { event, message, application_uuid, deployment_url, application_name, deployment_uuid } = payload;
  
  // Store Coolify event in database
  await insertEvent(
    `coolify_${event || 'unknown'}`,
    deployment_uuid || null,
    application_name || null,
    event || null,
    payload,
    'coolify'
  );
  
  if (!application_uuid) {
    return NextResponse.json({ received: true, ignored: 'no app uuid' });
  }
  
  const pending = pendingDeployments.get(application_uuid);
  if (!pending) {
    console.log(`[Coolify] No pending deployment for ${application_uuid}`);
    return NextResponse.json({ received: true, ignored: 'no pending deployment' });
  }
  
  const { octokit, owner, repo, deploymentId, checkRunId, appUrl } = pending;
  const logsUrl = deployment_url || pending.logsUrl;
  
  let ghState = 'in_progress';
  let description = message || 'Deploying...';
  let checkConclusion: string | null = null;
  
  if (event === 'deployment_success') {
    ghState = 'success';
    checkConclusion = 'success';
    description = message || 'Deployment successful';
    pendingDeployments.delete(application_uuid);
  } else if (event === 'deployment_failed') {
    ghState = 'failure';
    checkConclusion = 'failure';
    description = message || 'Deployment failed';
    pendingDeployments.delete(application_uuid);
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
