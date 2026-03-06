import { upsertRepo, getRepo, insertEvent, getPRReviewState, upsertPRReviewState } from './db';
import { runPRReview } from './pr-review';
import { getInstallationOctokit, createGitHubDeployment, updateDeploymentStatus, createCheck, updateCheck } from './github';
import { fetchCoolifyConfig, getCoolifyAppDetails, triggerCoolifyDeploy, registerPendingDeployment } from './coolify';

// OpenClaw notification config
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED === 'true';

// Regex to extract session key from PR body: <!-- oc-session:key -->
const SESSION_REGEX = /<!--\s*oc-session:([^\s]+)\s*-->/;
const REVIEW_TRIGGER_REGEX = /(^|\s)\/review(\s|$)/i;
const MENTION_TRIGGER = '@jean-ci review';

function enqueuePRReview(installationId: number, owner: string, repo: string, prNumber: number, headSha: string) {
  runPRReview(installationId, owner, repo, prNumber, headSha)
    .catch(err => console.error('PR review error:', err));
}

export async function handlePullRequest(payload: any) {
  const { action, pull_request, repository, installation } = payload;
  const repo = repository.full_name;

  await upsertRepo(repo, installation.id, false);
  const repoConfig = await getRepo(repo);
  if (!repoConfig?.pr_review_enabled) {
    return;
  }

  const [owner, repoName] = repo.split('/');
  const prNumber = pull_request.number;
  const headSha = pull_request.head.sha;
  const isDraft = !!pull_request.draft;

  if (action === 'ready_for_review') {
    const previousState = await getPRReviewState(repo, prNumber);
    await upsertPRReviewState({
      repo,
      pr_number: prNumber,
      last_reviewed_sha: headSha,
      is_draft: false,
      draft_reviewed: previousState?.draft_reviewed ?? false,
    });
    enqueuePRReview(installation.id, owner, repoName, prNumber, headSha);
    return;
  }

  if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') {
    return;
  }

  if (!isDraft) {
    const previousState = await getPRReviewState(repo, prNumber);
    await upsertPRReviewState({
      repo,
      pr_number: prNumber,
      last_reviewed_sha: headSha,
      is_draft: false,
      draft_reviewed: previousState?.draft_reviewed ?? false,
    });
    enqueuePRReview(installation.id, owner, repoName, prNumber, headSha);
    return;
  }

  const reviewState = await getPRReviewState(repo, prNumber);
  if (reviewState?.draft_reviewed) {
    await upsertPRReviewState({
      repo,
      pr_number: prNumber,
      last_reviewed_sha: reviewState.last_reviewed_sha,
      is_draft: true,
      draft_reviewed: true,
    });
    console.log(`⏭️ Draft PR ${repo}#${prNumber} already reviewed once, skipping`);
    return;
  }

  await upsertPRReviewState({
    repo,
    pr_number: prNumber,
    last_reviewed_sha: headSha,
    is_draft: true,
    draft_reviewed: true,
  });
  enqueuePRReview(installation.id, owner, repoName, prNumber, headSha);
}

export async function handleIssueComment(payload: any) {
  const { action, issue, comment, repository, installation } = payload;

  if (action !== 'created' || !issue?.pull_request) {
    return;
  }

  const body = (comment?.body || '').toLowerCase();
  if (!REVIEW_TRIGGER_REGEX.test(body) && !body.includes(MENTION_TRIGGER)) {
    return;
  }

  if (!installation?.id) {
    console.log('issue_comment missing installation id, skipping review trigger');
    return;
  }

  const repo = repository.full_name;
  await upsertRepo(repo, installation.id, false);
  const repoConfig = await getRepo(repo);
  if (!repoConfig?.pr_review_enabled) {
    return;
  }

  const [owner, repoName] = repo.split('/');
  const prNumber = issue.number;

  const octokit = await getInstallationOctokit(installation.id);
  const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo: repoName,
    pull_number: prNumber,
  });

  await upsertPRReviewState({
    repo,
    pr_number: prNumber,
    last_reviewed_sha: pr.head.sha,
    is_draft: !!pr.draft,
    draft_reviewed: !!pr.draft,
  });

  enqueuePRReview(installation.id, owner, repoName, prNumber, pr.head.sha);
}

export async function handlePullRequestReview(payload: any) {
  const { action, review, pull_request, repository } = payload;
  
  // Only handle submitted reviews that request changes
  if (action !== 'submitted' || review.state !== 'changes_requested') {
    return;
  }
  
  // Check if notifications are enabled
  if (!OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED || !OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('OpenClaw notification disabled or not configured');
    return;
  }
  
  // Extract session key from PR body (hidden comment)
  const prBody = pull_request.body || '';
  const match = prBody.match(SESSION_REGEX);
  
  if (!match) {
    console.log(`PR #${pull_request.number} has no oc-session comment, skipping notification`);
    return;
  }
  
  const sessionKey = match[1];
  console.log(`📢 Notifying session ${sessionKey} about changes requested on PR #${pull_request.number}`);
  
  const message = `🔧 **PR Review: Changes Requested**

**PR:** ${repository.full_name}#${pull_request.number} - ${pull_request.title}
**Reviewer:** ${review.user?.login}
**URL:** ${pull_request.html_url}

**Feedback:**
${review.body || 'No specific feedback provided.'}

Please address the requested changes and push a fix.`;

  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        sessionKey,
        message,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to notify OpenClaw: ${response.status} ${error}`);
    } else {
      console.log(`✅ Notification sent to session ${sessionKey}`);
    }
  } catch (error: any) {
    console.error(`Error notifying OpenClaw: ${error.message}`);
  }
}

export async function handleInstallation(payload: any) {
  const { action, installation, repositories } = payload;
  
  if (action === 'created' || action === 'added') {
    const repos = repositories || payload.repositories_added || [];
    for (const repo of repos) {
      await upsertRepo(repo.full_name, installation.id, false);
    }
  }
}

// Track in-flight deployments to prevent duplicate processing
const inFlightDeployments = new Set<string>();

export async function handleRegistryPackage(payload: any) {
  const { action, registry_package, repository, sender } = payload;
  
  if (action !== 'published') {
    console.log(`Registry package action: ${action} (ignoring)`);
    return;
  }

  const packageName = registry_package?.name;
  const packageVersion = registry_package?.package_version?.version;
  const packageUrl = registry_package?.package_version?.package_url || 
                     `ghcr.io/${repository.full_name.toLowerCase()}`;
  const headSha = registry_package?.package_version?.target_oid;
  
  // Deduplicate: skip if already processing this package+SHA combination
  const dedupeKey = `${packageUrl}:${headSha}`;
  if (inFlightDeployments.has(dedupeKey)) {
    console.log(`⏭️ Skipping duplicate registry_package for ${dedupeKey}`);
    return;
  }
  inFlightDeployments.add(dedupeKey);
  // Clean up after 5 minutes
  setTimeout(() => inFlightDeployments.delete(dedupeKey), 5 * 60 * 1000);
  
  console.log(`📦 Package published: ${packageUrl}:${packageVersion}`);

  const repoConfig = await getRepo(repository.full_name);
  if (!repoConfig) {
    console.log(`No config for ${repository.full_name}, skipping deploy`);
    return;
  }

  const octokit = await getInstallationOctokit(repoConfig.installation_id);
  const [owner, repo] = repository.full_name.split('/');
  
  const ref = registry_package?.package_version?.target_commitish || repository.default_branch || 'main';
  
  const coolifyConfig = await fetchCoolifyConfig(octokit, owner, repo, ref);
  
  if (!coolifyConfig || !coolifyConfig.deployments.length) {
    console.log(`No .jean-ci/coolify.yml found for ${repository.full_name}`);
    return;
  }

  const deployment = coolifyConfig.deployments.find((d: any) => {
    const configPackage = d.package.toLowerCase();
    return packageUrl.toLowerCase().includes(configPackage) || 
           configPackage.includes(packageName?.toLowerCase());
  });

  if (!deployment || !deployment.coolify_app) {
    console.log(`No matching Coolify app for package ${packageUrl}`);
    return;
  }

  const environment = deployment.environment || 'production';

  const appDetails = await getCoolifyAppDetails(deployment.coolify_app);
  const appUrl = appDetails?.fqdn || `https://${repo}.telegraphic.app`;
  const coolifyDashboard = process.env.COOLIFY_DASHBOARD_URL || 'https://apps.telegraphic.app';
  const logsUrl = `${coolifyDashboard}/project/${appDetails?.projectUuid || 'default'}/${appDetails?.environmentName || 'production'}/application/${deployment.coolify_app}`;

  // Create GitHub Check Run
  let checkRun = null;
  if (headSha) {
    try {
      checkRun = await createCheck(octokit, owner, repo, 'Coolify', headSha, 'in_progress');
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: 'Deploying to Coolify',
          summary: `Deploying ${packageVersion} to ${environment}...`,
        },
      });
    } catch (e: any) {
      console.error('Error creating check run:', e.message);
    }
  }

  // Create GitHub deployment
  const ghDeployment = await createGitHubDeployment(
    octokit, owner, repo, ref, environment,
    `Deploy ${packageVersion} to Coolify`
  );

  if (ghDeployment) {
    await updateDeploymentStatus(octokit, owner, repo, ghDeployment.id, 'in_progress',
      'Deploying to Coolify...', logsUrl, appUrl);
  }

  console.log(`🚀 Triggering Coolify deploy for ${deployment.coolify_app}`);
  const result = await triggerCoolifyDeploy(deployment.coolify_app);

  if (!result.success) {
    if (ghDeployment) {
      await updateDeploymentStatus(octokit, owner, repo, ghDeployment.id, 'failure',
        `Deploy failed: ${result.error}`, logsUrl, appUrl);
    }
    if (checkRun) {
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'Deploy failed', summary: result.error },
      });
    }
    console.error(`❌ Deployment failed: ${result.error}`);
    return;
  }

  // Store pending deployment for Coolify webhook (persisted to DB)
  await registerPendingDeployment(deployment.coolify_app, {
    owner, repo,
    headSha,
    deploymentId: ghDeployment?.id,
    checkRunId: checkRun?.id,
    coolifyDeploymentUuid: result.deploymentUuid,
    logsUrl, appUrl,
    installationId: repoConfig.installation_id,
  });

  // Record deployment started event (marks as pending in UI)
  // Prefix delivery_id with event type to avoid unique constraint conflict with success/failed events
  const startedDeliveryId = result.deploymentUuid ? `deployment_started:${result.deploymentUuid}` : null;
  await insertEvent(
    'coolify_deployment_started',
    startedDeliveryId,
    repository.full_name,
    'webhook_called',
    {
      app_uuid: deployment.coolify_app,
      deployment_uuid: result.deploymentUuid,
      _source_repo: repository.full_name,
      _source_sha: headSha,
      package_url: packageUrl,
      package_version: packageVersion,
      environment,
      logs_url: logsUrl,
      app_url: appUrl,
    },
    'jean-ci'
  );
  
  console.log(`✅ Deploy triggered for ${repository.full_name}, waiting for Coolify webhook...`);
}

export async function handleEvent(event: string, payload: any) {
  switch (event) {
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    case 'pull_request_review':
      await handlePullRequestReview(payload);
      break;
    case 'issue_comment':
      await handleIssueComment(payload);
      break;
    case 'installation':
    case 'installation_repositories':
      await handleInstallation(payload);
      break;
    case 'registry_package':
      await handleRegistryPackage(payload);
      break;
    default:
      console.log(`Event: ${event}`);
  }
}
