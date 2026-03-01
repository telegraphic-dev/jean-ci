import { upsertRepo, getRepo } from './db';
import { runPRReview } from './pr-review';
import { getInstallationOctokit, createGitHubDeployment, updateDeploymentStatus, createCheck, updateCheck } from './github';
import { fetchCoolifyConfig, getCoolifyAppDetails, triggerCoolifyDeploy, registerPendingDeployment } from './coolify';

// OpenClaw notification config
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED === 'true';

// Bot username to detect self-reviews
const BOT_USERNAME = process.env.GITHUB_BOT_USERNAME || 'jean-de-bot';

export async function handlePullRequest(payload: any) {
  const { action, pull_request, repository, installation } = payload;
  const repo = repository.full_name;
  
  await upsertRepo(repo, installation.id, false);
  
  if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
    const [owner, repoName] = repo.split('/');
    // Run asynchronously
    runPRReview(installation.id, owner, repoName, pull_request.number, pull_request.head.sha)
      .catch(err => console.error('PR review error:', err));
  }
}

export async function handlePullRequestReview(payload: any) {
  const { action, review, pull_request, repository } = payload;
  
  // Only handle submitted reviews that request changes
  if (action !== 'submitted' || review.state !== 'changes_requested') {
    return;
  }
  
  // Check if PR was created by the bot (we want to fix our own PRs)
  const prAuthor = pull_request.user?.login;
  if (prAuthor !== BOT_USERNAME) {
    console.log(`PR #${pull_request.number} not by ${BOT_USERNAME}, skipping notification`);
    return;
  }
  
  // Check if notifications are enabled
  if (!OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED || !OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('OpenClaw notification disabled or not configured');
    return;
  }
  
  // Look for oc-session label to find target session
  const labels = pull_request.labels || [];
  const sessionLabel = labels.find((l: any) => l.name?.startsWith('oc-session:'));
  
  if (!sessionLabel) {
    console.log(`PR #${pull_request.number} has no oc-session label, skipping notification`);
    return;
  }
  
  const sessionKey = sessionLabel.name.replace('oc-session:', '');
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
  
  console.log(`📦 Package published: ${packageUrl}:${packageVersion}`);

  const repoConfig = await getRepo(repository.full_name);
  if (!repoConfig) {
    console.log(`No config for ${repository.full_name}, skipping deploy`);
    return;
  }

  const octokit = await getInstallationOctokit(repoConfig.installation_id);
  const [owner, repo] = repository.full_name.split('/');
  
  const ref = registry_package?.package_version?.target_commitish || repository.default_branch || 'main';
  const headSha = registry_package?.package_version?.target_oid;
  
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

  // Trigger Coolify deploy
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

  // Store pending deployment for Coolify webhook
  registerPendingDeployment(deployment.coolify_app, {
    octokit, owner, repo, 
    deploymentId: ghDeployment?.id,
    checkRunId: checkRun?.id,
    logsUrl, appUrl,
    createdAt: Date.now(),
  });
  
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
