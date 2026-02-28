import { getRepo, getConfig, DEFAULT_USER_PROMPT, insertCheckRun, setCheckRunGithubId, updateCheckRun } from './db';
import { getInstallationOctokit, fetchPRCheckFiles, getPRInfo, getPRDiff, createCheck, updateCheck } from './github';
import { callOpenClaw } from './llm';

const BASE_URL = process.env.BASE_URL || 'https://jean-ci.telegraphic.app';

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
        diff_preview: diff.substring(0, 10000),
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

      const context = `
# Pull Request: ${prInfo.title}

## Description
${prInfo.body || 'No description provided'}

## Diff
${'```'}diff
${diff.substring(0, 50000)}${diff.length > 50000 ? '\n... [truncated]' : ''}
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
