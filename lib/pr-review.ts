import { getRepo, getConfig, DEFAULT_USER_PROMPT, insertCheckRun, setCheckRunGithubId, updateCheckRun } from './db';
import { getInstallationOctokit, fetchPRCheckFiles, getPRInfo, getPRDiff, createCheck, updateCheck } from './github';
import { callOpenClaw } from './llm';

const BASE_URL = process.env.BASE_URL || 'https://jean-ci.telegraphic.app';

// Configurable diff limits with generous defaults
// Can be overridden via environment variables
const DIFF_PREVIEW_LIMIT = parseInt(process.env.DIFF_PREVIEW_LIMIT || '50000');  // 50K for DB storage
const DIFF_LLM_LIMIT = parseInt(process.env.DIFF_LLM_LIMIT || '200000');          // 200K for LLM context

/**
 * Truncate diff with informative message about what was cut
 */
function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) {
    return diff;
  }
  
  const truncated = diff.substring(0, limit);
  const remaining = diff.length - limit;
  const remainingKB = Math.round(remaining / 1024);
  
  // Try to cut at a file boundary for cleaner output
  const lastFileStart = truncated.lastIndexOf('\ndiff --git');
  const cutPoint = lastFileStart > limit * 0.8 ? lastFileStart : limit;
  
  return truncated.substring(0, cutPoint) + 
    `\n\n... [truncated: ${remainingKB}KB remaining, ${diff.split('\ndiff --git').length - truncated.substring(0, cutPoint).split('\ndiff --git').length} files not shown]`;
}

export async function runPRReview(installationId: number, owner: string, repo: string, prNumber: number, headSha: string) {
  const repoFullName = `${owner}/${repo}`;
  const repoConfig = await getRepo(repoFullName);
  
  if (!repoConfig || !repoConfig.pr_review_enabled) {
    console.log(`PR review disabled for ${repoFullName}`);
    return;
  }

  const octokit = await getInstallationOctokit(installationId);
  
  // Get PR info and diff first
  const [prInfo, diff] = await Promise.all([
    getPRInfo(octokit, owner, repo, prNumber),
    getPRDiff(octokit, owner, repo, prNumber),
  ]);

  console.log(`Diff size: ${Math.round(diff.length / 1024)}KB (limits: preview=${DIFF_PREVIEW_LIMIT}, llm=${DIFF_LLM_LIMIT})`);

  // Fetch check files from repo
  const checkFiles = await fetchPRCheckFiles(octokit, owner, repo, headSha);
  const userPrompt = await getConfig('user_prompt') || DEFAULT_USER_PROMPT;

  // Build checks to run
  const checks = [
    { name: 'Code Review', prompt: userPrompt, isGlobal: true },
    ...checkFiles.map(f => ({ name: f.name, prompt: f.content, isGlobal: false })),
  ];

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  // Create ALL checks as pending first, storing in DB
  const checkRuns = [];
  for (const check of checks) {
    try {
      // Store in DB first
      const dbId = await insertCheckRun({
        repo: repoFullName,
        pr_number: prNumber,
        check_name: check.name,
        head_sha: headSha,
        prompt: check.prompt,
        pr_title: prInfo.title,
        pr_body: prInfo.body || '',
        diff_preview: truncateDiff(diff, DIFF_PREVIEW_LIMIT),
      });

      // Create GitHub check with details URL
      const checkRun = await createCheck(octokit, owner, repo, `jean-ci / ${check.name}`, headSha, 'queued');
      
      // Update DB with GitHub check ID
      await setCheckRunGithubId(dbId, checkRun.id);
      
      checkRuns.push({ check, checkRun, dbId });
      console.log(`Created pending check: ${check.name} (db: ${dbId})`);
    } catch (error: any) {
      console.error(`Error creating check "${check.name}":`, error.message);
    }
  }

  // Run each check
  for (const { check, checkRun, dbId } of checkRuns) {
    try {
      // Mark as in_progress
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
      });

      const truncatedDiff = truncateDiff(diff, DIFF_LLM_LIMIT);
      const context = `
# Pull Request: ${prInfo.title}

## Description
${prInfo.body || 'No description provided'}

## Diff
${'```'}diff
${truncatedDiff}
${'```'}
`;

      const result = await callOpenClaw(check.prompt, context);
      
      // Parse verdict
      let conclusion = 'success';
      let title = '✅ Approved';
      
      if (!result.success) {
        conclusion = 'failure';
        title = '❌ Review failed';
      } else {
        const response = result.response.toUpperCase();
        if (response.includes('VERDICT: FAIL') || response.includes('VERDICT:FAIL')) {
          conclusion = 'failure';
          title = '❌ Changes requested';
        } else {
          conclusion = 'success';
          title = '✅ Approved';
        }
      }

      const summary = result.success ? result.response.substring(0, 65535) : `Error: ${result.error}`;

      // Create PR review comment (visible on PR page)
      if (result.success && check.isGlobal) {
        try {
          const reviewEvent = conclusion === 'success' ? 'APPROVE' : 'REQUEST_CHANGES';
          const reviewBody = `## ${title}\n\n${result.response.substring(0, 65000)}\n\n---\n*[View full details](${BASE_URL}/checks/${dbId})*`;
          
          await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
            owner, repo, pull_number: prNumber,
            event: reviewEvent,
            body: reviewBody,
          });
          console.log(`Created PR review: ${reviewEvent}`);
        } catch (e: any) {
          console.error('Failed to create PR review:', e.message);
        }
      }

      // Update GitHub check
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
        output: { title, summary },
      });

      // Store in DB
      await updateCheckRun(dbId, {
        status: 'completed',
        conclusion,
        title,
        summary,
        completed_at: new Date(),
      });

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error: any) {
      console.error(`Error running check "${check.name}":`, error.message);
      
      // Mark as failed on error
      try {
        await updateCheck(octokit, owner, repo, checkRun.id, {
          status: 'completed',
          conclusion: 'failure',
          completed_at: new Date().toISOString(),
          output: {
            title: '❌ Check failed',
            summary: `Error: ${error.message}`,
          },
        });
      } catch (e: any) {
        console.error('Failed to update check status:', e.message);
      }
    }
  }
}
