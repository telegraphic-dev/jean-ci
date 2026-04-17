import { getRepo, getConfig, DEFAULT_USER_PROMPT, insertCheckRun, setCheckRunGithubId, updateCheckRun } from './db';
import { getInstallationOctokit, fetchPRCheckFiles, getPRInfo, getPRDiff, createCheck, updateCheck, createPRReview } from './github';
import { callOpenClaw } from './llm';
import { buildPromptValidationSummary, parseReviewResponse, validateReviewPrompt } from './review-output';
import { APP_BASE_URL } from './config';
import { buildExecutionFailureOutcome } from './review-failure';
import { buildReviewContext, truncateReviewDiff } from './review-context';

const BASE_URL = APP_BASE_URL;

// Configurable diff limits with generous defaults
// Can be overridden via environment variables
const DIFF_PREVIEW_LIMIT = parseInt(process.env.DIFF_PREVIEW_LIMIT || '50000');  // 50K for DB storage
const DIFF_LLM_LIMIT = parseInt(process.env.DIFF_LLM_LIMIT || '200000');          // 200K for LLM context

interface ReviewCheck {
  name: string;
  prompt: string;
  isGlobal: boolean;
}


function getConclusionForVerdict(verdict: 'PASS' | 'FAIL'): 'success' | 'failure' {
  return verdict === 'PASS' ? 'success' : 'failure';
}

function normalizeChecks(userPrompt: string, checkFiles: Array<{ name: string; content: string }>): ReviewCheck[] {
  return [
    { name: 'Code Review', prompt: userPrompt, isGlobal: true },
    ...checkFiles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => ({ name: file.name, prompt: file.content, isGlobal: false })),
  ];
}

async function completeCheck(
  octokit: any,
  owner: string,
  repo: string,
  checkRunId: number,
  dbId: number,
  payload: {
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
  },
) {
  await updateCheck(octokit, owner, repo, checkRunId, {
    status: 'completed',
    conclusion: payload.conclusion,
    completed_at: new Date().toISOString(),
    details_url: `${BASE_URL}/checks/${dbId}`,
    output: { title: payload.title, summary: payload.summary },
  });

  await updateCheckRun(dbId, {
    status: 'completed',
    conclusion: payload.conclusion,
    title: payload.title,
    summary: payload.summary,
    completed_at: new Date(),
  });
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
  const checks = normalizeChecks(userPrompt, checkFiles);

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  const diffPreview = truncateReviewDiff(diff, DIFF_PREVIEW_LIMIT);
  const reviewContext = buildReviewContext({
    title: prInfo.title,
    body: prInfo.body,
    diff,
    diffLimit: DIFF_LLM_LIMIT,
    owner,
    repo,
  });

  // Create ALL checks as pending first, storing in DB
  const checkRuns = [];
  for (const check of checks) {
    try {
      const dbId = await insertCheckRun({
        repo: repoFullName,
        pr_number: prNumber,
        check_name: check.name,
        head_sha: headSha,
        prompt: check.prompt,
        pr_title: prInfo.title,
        pr_body: prInfo.body || '',
        diff_preview: diffPreview,
      });

      const checkRun = await createCheck(octokit, owner, repo, `jean-ci / ${check.name}`, headSha, 'queued');
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
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
      });

      if (!check.isGlobal) {
        const promptValidation = validateReviewPrompt(check.prompt);
        if (!promptValidation.valid) {
          await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
            conclusion: 'failure',
            title: '❌ Invalid review prompt',
            summary: buildPromptValidationSummary(promptValidation.errors),
          });
          console.log(`Check "${check.name}" failed prompt validation`);
          continue;
        }
      }

      const result = await callOpenClaw(check.prompt, reviewContext, {
        owner,
        repo,
        prNumber,
        promptName: check.isGlobal ? 'review' : check.name,
        headSha,
      });
      if (!result.success) {
        const failure = buildExecutionFailureOutcome(result.errorType, result.error);
        await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: failure.conclusion,
          title: failure.title,
          summary: failure.summary,
        });
        console.log(`Check "${check.name}" ${failure.conclusion === 'neutral' ? 'marked neutral due to gateway outage' : 'failed during reviewer execution'}`);
        continue;
      }

      const parsed = parseReviewResponse(result.response);
      const conclusion = getConclusionForVerdict(parsed.verdict);

      if (check.isGlobal) {
        try {
          const reviewEvent = conclusion === 'success' ? 'APPROVE' : 'REQUEST_CHANGES';
          const reviewBody = `## ${parsed.title}\n\n${parsed.normalized.substring(0, 65000)}\n\n---\n*[View full details](${BASE_URL}/checks/${dbId})*`;

          await createPRReview(octokit, owner, repo, prNumber, reviewEvent, reviewBody);
          console.log(`Created PR review: ${reviewEvent}`);
        } catch (e: any) {
          console.error('Failed to create PR review:', e.message);
        }
      }

      await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
        conclusion,
        title: parsed.title,
        summary: parsed.summary,
      });

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error: any) {
      console.error(`Error running check "${check.name}":`, error.message);

      try {
        await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'failure',
          title: '❌ Check failed',
          summary: `Review run failed before completion.\n\n- ${error.message}`,
        });
      } catch (updateError: any) {
        console.error('Failed to update check status:', updateError.message);
      }
    }
  }
}
