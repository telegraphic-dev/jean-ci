import { getRepo, getConfig, DEFAULT_USER_PROMPT, insertCheckRun, setCheckRunGithubId, setReservedCheckInput, updateCheckRun } from './db.ts';
import { getInstallationOctokit, fetchPRCheckFiles, getPRInfo, getPRDiff, createCheck, updateCheck, createPRReview } from './github.ts';
import { callOpenClaw } from './llm.ts';
import { withReviewInterruption, REVIEW_INTERRUPTION_NOTICE, boundReviewMarkdown, linkReviewedLocations, buildPublicCheckSummary, buildPRReviewBody, buildPromptValidationSummary, combineChunkedReviewResponses, parseReviewResponse, validateReviewPrompt } from './review-output.ts';
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
  identity: string;
  name: string;
  prompt: string;
  isGlobal: boolean;
}


function getConclusionForVerdict(verdict: 'PASS' | 'FAIL'): 'success' | 'failure' {
  return verdict === 'PASS' ? 'success' : 'failure';
}

function normalizeChecks(userPrompt: string, checkFiles: Array<{ name: string; content: string; path?: string }>): ReviewCheck[] {
  return [
    { identity: 'global:code-review', name: 'Code Review', prompt: userPrompt, isGlobal: true },
    ...checkFiles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => ({ identity: `path:${file.path ?? `.jean-ci/pr-checks/${file.name}.md`}`, name: file.name, prompt: file.content, isGlobal: false })),
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
    /** Readable public Markdown, never transport diagnostics. */
    summary: string;
    /** Full authenticated diagnostic record; defaults to summary for status-only outcomes. */
    diagnostics?: string;
  },
) {
  await updateCheck(octokit, owner, repo, checkRunId, {
    status: 'completed',
    conclusion: payload.conclusion,
    completed_at: new Date().toISOString(),
    details_url: `${BASE_URL}/checks/${dbId}`,
    output: { title: payload.title, summary: boundReviewMarkdown(payload.summary, 65535, `${BASE_URL}/checks/${dbId}`) },
  });

  await updateCheckRun(dbId, {
    status: 'completed',
    conclusion: payload.conclusion,
    title: payload.title,
    summary: payload.diagnostics ?? payload.summary,
    completed_at: new Date(),
  });
}

export async function runPRReview(installationId: number, owner: string, repo: string, prNumber: number, headSha: string, restart?: { checkId: number; checkName: string; checkIdentity?: string; assertOwner?: () => Promise<void> }) {
  const complete = async (...args: Parameters<typeof completeCheck>) => {
    await restart?.assertOwner?.();
    return completeCheck(...args);
  };
  const repoFullName = `${owner}/${repo}`;
  const repoConfig = await getRepo(repoFullName);

  if (!repoConfig || !repoConfig.pr_review_enabled) {
    if (restart) throw new Error('Repository review disabled');
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

  if (!isCurrentReviewHead(headSha, prInfo.head?.sha) || (restart && prInfo.state !== 'open')) {
    if (restart) throw new Error('PR closed or head changed');
    console.log(`⏭️ Skipping stale PR review for ${repoFullName}#${prNumber} (${headSha}); current head is ${prInfo.head?.sha}`);
    return;
  }

  console.log(`Diff size: ${Math.round(diff.length / 1024)}KB (limits: preview=${DIFF_PREVIEW_LIMIT}, llm=${DIFF_LLM_LIMIT})`);

  // Fetch check files from repo
  const checkFiles = await fetchPRCheckFiles(octokit, owner, repo, headSha);
  const userPrompt = await getConfig('user_prompt') || DEFAULT_USER_PROMPT;
  const checks = normalizeChecks(userPrompt, checkFiles).filter(c => !restart || (restart.checkIdentity ? c.identity === restart.checkIdentity : c.name === restart.checkName));
  if (restart && checks.length !== 1) throw new Error('The requested check is missing or its legacy name is ambiguous at the reviewed head');

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  const diffPreview = truncateReviewDiff(diff, DIFF_PREVIEW_LIMIT);

  // Create ALL checks as pending first, storing in DB
  const checkRuns = [];
  for (const check of checks) {
    try {
      const dbId = restart?.checkId ?? await insertCheckRun({
        repo: repoFullName,
        pr_number: prNumber,
        check_name: check.name,
        check_identity: check.identity,
        head_sha: headSha,
        prompt: check.prompt,
        pr_title: prInfo.title,
        pr_body: prInfo.body || '',
        diff_preview: diffPreview,
      });

      await restart?.assertOwner?.();
      if (restart) await setReservedCheckInput(dbId, headSha, { prompt: check.prompt, pr_title: prInfo.title, pr_body: prInfo.body || '', diff_preview: diffPreview });
      const checkRun = await createCheck(octokit, owner, repo, `jean-ci / ${check.name}`, headSha, 'queued');
      await setCheckRunGithubId(dbId, checkRun.id);

      checkRuns.push({ check, checkRun, dbId });
      console.log(`Created pending check: ${check.name} (db: ${dbId})`);
    } catch (error: any) {
      if (restart) throw error;
      console.error(`Error creating check "${check.name}":`, error.message);
    }
  }

  // Run each check
  for (const { check, checkRun, dbId } of checkRuns) {
    try {
      await restart?.assertOwner?.();
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
      });

      if (!check.isGlobal) {
        const promptValidation = validateReviewPrompt(check.prompt);
        if (!promptValidation.valid) {
          await complete(octokit, owner, repo, checkRun.id, dbId, {
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
        await restart?.assertOwner?.();
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
            await restart?.assertOwner?.();
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
          await complete(octokit, owner, repo, checkRun.id, dbId, {
            conclusion: 'failure',
            title: preservedFailure.title,
            summary: `${linkReviewedLocations(preservedFailure.reviewMarkdown, { owner, repo, headSha, diff })}\n\n${REVIEW_INTERRUPTION_NOTICE} [View full details](${BASE_URL}/checks/${dbId})`,
            diagnostics: withReviewInterruption(preservedFailure.normalized, executionFailure.summary),
          });
          console.log(`Check "${check.name}" preserved an earlier blocking finding after a later reviewer execution failure`);
          continue;
        }
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: executionFailure.conclusion,
          title: executionFailure.title,
          summary: `Reviewer execution did not finish. [View full details](${BASE_URL}/checks/${dbId})`,
          diagnostics: executionFailure.summary,
        });
        console.log(`Check "${check.name}" ${executionFailure.conclusion === 'neutral' ? 'marked neutral due to gateway outage' : 'failed during reviewer execution'}`);
        continue;
      }

      const parsed = combineChunkedReviewResponses(chunkedResponses);
      const conclusion = getConclusionForVerdict(parsed.verdict);

      const latestPrInfo = await getPRInfo(octokit, owner, repo, prNumber);
      if (!isCurrentReviewHead(headSha, latestPrInfo.head?.sha)) {
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'neutral',
          title: '⚠️ Review superseded',
          summary: `The PR head changed while this review was running, so its result was discarded.\n\n- Reviewed head: ${headSha}\n- Current head: ${latestPrInfo.head?.sha || 'unknown'}`,
        });
        console.log(`Check "${check.name}" superseded by newer head for ${repoFullName}#${prNumber}`);
        continue;
      }

      if (check.isGlobal) {
        await restart?.assertOwner?.();
        try {
          const reviewEvent = conclusion === 'success' ? 'APPROVE' : 'REQUEST_CHANGES';
          const reviewBody = buildPRReviewBody(parsed, { owner, repo, headSha, diff }, `${BASE_URL}/checks/${dbId}`);

          await createPRReview(octokit, owner, repo, prNumber, reviewEvent, reviewBody, headSha);
          console.log(`Created PR review: ${reviewEvent}`);
        } catch (e: any) {
          console.error('Failed to create PR review:', e.message);
        }
      }

      await complete(octokit, owner, repo, checkRun.id, dbId, {
        conclusion,
        title: parsed.title,
        summary: buildPublicCheckSummary(parsed, { owner, repo, headSha, diff }, `${BASE_URL}/checks/${dbId}`),
        diagnostics: parsed.normalized,
      });

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error: any) {
      console.error(`Error running check "${check.name}":`, error.message);

      try {
        await complete(octokit, owner, repo, checkRun.id, dbId, {
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
