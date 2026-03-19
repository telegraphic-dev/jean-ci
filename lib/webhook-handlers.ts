import { upsertRepo, getRepo, insertEvent, getPRReviewState, upsertPRReviewState, upsertAppMapping, getLatestCheckRunIdByGithubCheckId } from './db';
import { runPRReview } from './pr-review';
import { getInstallationOctokit, createGitHubDeployment, updateDeploymentStatus, createCheck, updateCheck } from './github';
import { registerPendingDeployment } from './coolify';
import { fetchDeploymentConfig, findMatchingDeployment, getDeploymentProvider, validateDeploymentTarget } from './deploy-providers';
import { extractPaperclipIssueIds, isPaperclipConfigured, markLinkedPaperclipIssuesDone, commentLinkedPaperclipIssuesOnFailedChecks, type FailedCheckSummary } from './paperclip';
import { APP_BASE_URL } from './config';

// OpenClaw notification config
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED === 'true';

// Regex to extract session key from PR body: <!-- oc-session:key -->
const SESSION_REGEX = /<!--\s*oc-session:([^\s]+)\s*-->/;
const REVIEW_TRIGGER_REGEX = /(^|\s)\/review(\s|$)/i;
const MENTION_TRIGGER = '@jean-ci review';
const FAILING_CHECK_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out',
]);

function enqueuePRReview(installationId: number, owner: string, repo: string, prNumber: number, headSha: string) {
  runPRReview(installationId, owner, repo, prNumber, headSha)
    .catch(err => console.error('PR review error:', err));
}

export async function handlePullRequest(payload: any) {
  const { action, pull_request, repository, installation } = payload;
  const repo = repository.full_name;

  await upsertRepo(repo, installation.id, false);

  if (action === 'closed' && pull_request?.merged) {
    const issueIds = extractPaperclipIssueIds(
      pull_request?.body,
      pull_request?.title,
      pull_request?.head?.ref,
      pull_request?.base?.ref,
    );

    if (issueIds.length > 0) {
      if (!isPaperclipConfigured()) {
        console.warn(`Paperclip links found for ${repo}#${pull_request.number}, but Paperclip is not configured`);
      } else {
        try {
          await markLinkedPaperclipIssuesDone({
            prUrl: pull_request.html_url,
            repoFullName: repo,
            prNumber: pull_request.number,
            prTitle: pull_request.title,
            issueIds,
          });
          console.log(`✅ Marked Paperclip issues done for ${repo}#${pull_request.number}: ${issueIds.join(', ')}`);
        } catch (error: any) {
          console.error(`Failed to sync merged PR ${repo}#${pull_request.number} to Paperclip: ${error.message}`);
        }
      }
    }
  }

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

function getFailedCheckRuns(checkRuns: any[]): any[] {
  return checkRuns.filter((run) => {
    const conclusion = String(run?.conclusion || '').toLowerCase();
    return run?.status === 'completed' && FAILING_CHECK_CONCLUSIONS.has(conclusion);
  });
}

async function resolveJeanCheckUrl(githubCheckRunId: number | null | undefined): Promise<string | null> {
  if (!githubCheckRunId) return null;

  const checkId = await getLatestCheckRunIdByGithubCheckId(githubCheckRunId);
  if (!checkId) return null;

  return `${APP_BASE_URL}/checks/${checkId}`;
}

export async function handleCheckSuite(payload: any) {
  const { action, check_suite, repository, installation } = payload;

  if (action !== 'completed') {
    return;
  }

  if (!check_suite?.head_sha || !repository?.full_name || !installation?.id) {
    return;
  }

  if (!isPaperclipConfigured()) {
    return;
  }

  const pullRequests = check_suite.pull_requests || [];
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    return;
  }

  const [owner, repo] = String(repository.full_name).split('/');
  const octokit = await getInstallationOctokit(installation.id);
  const checkRuns = await octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo,
    ref: check_suite.head_sha,
    per_page: 100,
  }, (response: any) => response.data.check_runs || []);

  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return;
  }

  const allChecksCompleted = checkRuns.every((run: any) => run?.status === 'completed');
  if (!allChecksCompleted) {
    return;
  }

  const failedCheckRuns = getFailedCheckRuns(checkRuns);
  if (failedCheckRuns.length === 0) {
    return;
  }

  const failedChecks: FailedCheckSummary[] = [];
  for (const run of failedCheckRuns) {
    const checkRunUrl = run?.html_url || null;
    const workflowUrl = run?.details_url || null;
    const jeanCheckUrl = await resolveJeanCheckUrl(run?.id);

    failedChecks.push({
      name: run?.name || `check-${run?.id || 'unknown'}`,
      conclusion: String(run?.conclusion || 'failure'),
      checkRunUrl,
      workflowUrl,
      jeanCheckUrl,
    });
  }

  for (const linkedPr of pullRequests) {
    const prNumber = linkedPr?.number;
    if (!prNumber) continue;

    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
    });

    if (pr?.state === 'closed' && !pr?.merged_at) {
      continue;
    }

    const issueIds = extractPaperclipIssueIds(
      pr?.body,
      pr?.title,
      pr?.head?.ref,
      pr?.base?.ref,
    );

    if (issueIds.length === 0) {
      continue;
    }

    try {
      await commentLinkedPaperclipIssuesOnFailedChecks({
        issueIds,
        repoFullName: repository.full_name,
        prNumber,
        headSha: check_suite.head_sha,
        prTitle: pr?.title || `PR #${prNumber}`,
        prUrl: pr?.html_url || `https://github.com/${repository.full_name}/pull/${prNumber}`,
        failedChecks,
      });
      console.log(`⚠️ Posted Paperclip failing-checks comment for ${repository.full_name}#${prNumber}`);
    } catch (error: any) {
      console.error(`Failed to post Paperclip failing-checks comment for ${repository.full_name}#${prNumber}: ${error.message}`);
    }
  }
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

  const deploymentConfig = await fetchDeploymentConfig(octokit, owner, repo, ref);

  if (!deploymentConfig || !deploymentConfig.deployments.length) {
    console.log(`No deployment config found for ${repository.full_name}`);
    return;
  }

  const deployment = findMatchingDeployment(deploymentConfig, packageUrl, packageName);
  if (!deployment) {
    console.log(`No matching deployment target for package ${packageUrl}`);
    return;
  }

  const validationErrors = validateDeploymentTarget(deployment);
  if (validationErrors.length) {
    console.error(`Invalid deployment target for ${repository.full_name}: ${validationErrors.join('; ')}`);
    return;
  }

  const provider = getDeploymentProvider(deployment.provider);
  if (!provider) {
    console.error(`Unknown deployment provider: ${deployment.provider}`);
    return;
  }

  const environment = deployment.environment || (deployment.provider === 'noop' ? 'review-only' : 'production');

  const providerLabel = deployment.provider === 'noop'
    ? 'Deployment (noop)'
    : `${deployment.provider[0].toUpperCase()}${deployment.provider.slice(1)}`;

  // Create GitHub Check Run
  let checkRun = null;
  if (headSha) {
    try {
      checkRun = await createCheck(octokit, owner, repo, providerLabel, headSha, 'in_progress');
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: `Deploying via ${deployment.provider}`,
          summary: `Deploying ${packageVersion} to ${environment} with provider ${deployment.provider}...`,
        },
      });
    } catch (e: any) {
      console.error('Error creating check run:', e.message);
    }
  }

  // Create GitHub deployment
  const ghDeployment = await createGitHubDeployment(
    octokit, owner, repo, ref, environment,
    `Deploy ${packageVersion} via ${deployment.provider}`
  );

  const result = await provider.trigger(deployment, {
    owner,
    repo,
    packageUrl,
    packageName,
  });

  const pendingExternalCompletion = deployment.provider === 'coolify';

  if (ghDeployment) {
    await updateDeploymentStatus(
      octokit,
      owner,
      repo,
      ghDeployment.id,
      result.success ? (pendingExternalCompletion ? 'in_progress' : 'success') : 'failure',
      result.success
        ? (pendingExternalCompletion ? `Deploying via ${deployment.provider}...` : `Deployment handled by ${deployment.provider}`)
        : `Deploy failed: ${result.error}`,
      result.logsUrl,
      result.appUrl,
    );
  }

  if (!result.success) {
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

  if (!pendingExternalCompletion && checkRun) {
    await updateCheck(octokit, owner, repo, checkRun.id, {
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Deploy handled',
        summary: `Deployment handled by ${deployment.provider}.`,
      },
    });
  }

  if (deployment.provider === 'coolify' && result.appUuid) {
    await registerPendingDeployment(result.appUuid, {
      owner, repo,
      headSha,
      deploymentId: ghDeployment?.id,
      checkRunId: checkRun?.id,
      coolifyDeploymentUuid: result.deploymentUuid,
      logsUrl: result.logsUrl || '',
      appUrl: result.appUrl || '',
      installationId: repoConfig.installation_id,
    });

    await upsertAppMapping({
      coolify_app_uuid: result.appUuid,
      github_repo: repository.full_name,
      coolify_app_name: result.appName || null,
      coolify_app_fqdn: result.appUrl || null,
      installation_id: repoConfig.installation_id,
      last_deployed_sha: headSha,
    });
    console.log(`📍 Mapped Coolify app ${result.appUuid} → ${repository.full_name}`);
  }

  await insertEvent(
    `${deployment.provider}_deployment_started`,
    result.deploymentUuid || null,
    repository.full_name,
    'webhook_called',
    {
      provider: deployment.provider,
      app_uuid: result.appUuid || null,
      deployment_uuid: result.deploymentUuid,
      _source_repo: repository.full_name,
      _source_sha: headSha,
      package_url: packageUrl,
      package_version: packageVersion,
      environment,
      logs_url: result.logsUrl,
      app_url: result.appUrl,
    },
    'jean-ci'
  );

  console.log(`✅ Deploy triggered for ${repository.full_name} via ${deployment.provider}`);
}

export async function handleEvent(event: string, payload: any) {
  switch (event) {
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    case 'pull_request_review':
      await handlePullRequestReview(payload);
      break;
    case 'check_suite':
      await handleCheckSuite(payload);
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
