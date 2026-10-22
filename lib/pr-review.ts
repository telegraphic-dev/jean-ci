import { getRepo, getConfig, DEFAULT_USER_PROMPT, insertCheckRun, setCheckRunGithubId, updateCheckRun } from './db.ts';
import { getInstallationOctokit, fetchPRCheckFiles, getPRInfo, getPRDiff, createCheck, updateCheck, createPRReview } from './github.ts';
import { callOpenClaw } from './llm.ts';
import { buildPromptValidationSummary, combineChunkedReviewResponses, parseReviewResponse, validateReviewPrompt } from './review-output.ts';
import { APP_BASE_URL } from './config.ts';
import { buildExecutionFailureOutcome } from './review-failure.ts';
import { buildReviewContexts, truncateReviewDiff } from './review-context.ts';
import { isCurrentReviewHead } from './review-head.ts';

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
  const prInfo = await getPRInfo(octokit, owner, repo, prNumber);
  const diff = await getPRDiff(octokit, owner, repo, prNumber, {
    baseRef: prInfo.base?.sha,
    headRef: prInfo.head?.sha,
  });

  if (!isCurrentReviewHead(headSha, prInfo.head?.sha)) {
    console.log(`⏭️ Skipping stale PR review for ${repoFullName}#${prNumber} (${headSha}); current head is ${prInfo.head?.sha}`);
    return;
  }

  console.log(`Diff size: ${Math.round(diff.length / 1024)}KB (limits: preview=${DIFF_PREVIEW_LIMIT}, llm=${DIFF_LLM_LIMIT})`);

  // Fetch check files from repo
  const checkFiles = await fetchPRCheckFiles(octokit, owner, repo, headSha);
  const userPrompt = await getConfig('user_prompt') || DEFAULT_USER_PROMPT;
  const checks = normalizeChecks(userPrompt, checkFiles);

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  const diffPreview = truncateReviewDiff(diff, DIFF_PREVIEW_LIMIT);

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

      const reviewContexts = buildReviewContexts({
        title: prInfo.title,
        body: prInfo.body,
        diff,
        userPrompt: check.prompt,
        diffLimit: DIFF_LLM_LIMIT,
        owner,
        repo,
      });
      const chunkedResponses = [];
      let executionFailure: ReturnType<typeof buildExecutionFailureOutcome> | null = null;
      for (const [index, reviewContext] of reviewContexts.entries()) {
        let approvalWaitReported = false;
        const result = await callOpenClaw(check.prompt, reviewContext.context, {
          owner,
          repo,
          prNumber,
          promptName: `${check.isGlobal ? 'review' : check.name}-${index + 1}`,
          headSha,
          checkId: dbId,
          segment: index + 1,
          onWaiting: async () => {
            const title = 'Tool approval required';
            const summary = `Review paused for an operator decision. [Open the authenticated check page](${BASE_URL}/checks/${dbId}) to approve once or deny. Native approval expiry still applies.`;
            if (!approvalWaitReported) {
              await updateCheckRun(dbId, { status: 'in_progress', title, summary });
              try {
                await updateCheck(octokit, owner, repo, checkRun.id, {
                  status: 'in_progress', details_url: `${BASE_URL}/checks/${dbId}`,
                  output: { title, summary },
                });
                approvalWaitReported = true;
              } catch { console.warn('Optional GitHub approval status unavailable; will retry while polling'); }
            }
            const { postReviewApprovalComments } = await import('./review-approval-comments.ts');
            await postReviewApprovalComments(dbId);
            // Only a link and server-owned repo/SHA are sent, never tool text.
            const { notifyReviewApproval } = await import('./review-approvals.ts');
            await notifyReviewApproval(dbId);
          },
        });
        if (!result.success) {
          executionFailure = buildExecutionFailureOutcome(result.errorType, result.error);
          break;
        }
        try {
          chunkedResponses.push({ label: reviewContext.label, parsed: parseReviewResponse(result.response) });
        } catch (error) {
          executionFailure = buildExecutionFailureOutcome('unknown', error instanceof Error ? error.message : String(error));
          break;
        }
      }
      if (executionFailure) {
        const priorFailure = chunkedResponses.find(({ parsed }) => parsed.verdict === 'FAIL');
        if (priorFailure) {
          const preservedFailure = combineChunkedReviewResponses(chunkedResponses);
          await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
            conclusion: 'failure',
            title: preservedFailure.title,
            summary: `${preservedFailure.summary}\n\n- Review of remaining segments stopped after a reviewer execution failure: ${executionFailure.summary}`,
          });
          console.log(`Check "${check.name}" preserved an earlier blocking finding after a later reviewer execution failure`);
          continue;
        }
        await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: executionFailure.conclusion,
          title: executionFailure.title,
          summary: executionFailure.summary,
        });
        console.log(`Check "${check.name}" ${executionFailure.conclusion === 'neutral' ? 'marked neutral due to gateway outage' : 'failed during reviewer execution'}`);
        continue;
      }

      const parsed = combineChunkedReviewResponses(chunkedResponses);
      const conclusion = getConclusionForVerdict(parsed.verdict);

      const latestPrInfo = await getPRInfo(octokit, owner, repo, prNumber);
      if (!isCurrentReviewHead(headSha, latestPrInfo.head?.sha)) {
        await completeCheck(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'neutral',
          title: '⚠️ Review superseded',
          summary: `The PR head changed while this review was running, so its result was discarded.\n\n- Reviewed head: ${headSha}\n- Current head: ${latestPrInfo.head?.sha || 'unknown'}`,
        });
        console.log(`Check "${check.name}" superseded by newer head for ${repoFullName}#${prNumber}`);
        continue;
      }

      if (check.isGlobal) {
        try {
          const reviewEvent = conclusion === 'success' ? 'APPROVE' : 'REQUEST_CHANGES';
          const reviewBody = `## ${parsed.title}\n\n${parsed.normalized.substring(0, 65000)}\n\n---\n*[View full details](${BASE_URL}/checks/${dbId})*`;

          await createPRReview(octokit, owner, repo, prNumber, reviewEvent, reviewBody, headSha);
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
