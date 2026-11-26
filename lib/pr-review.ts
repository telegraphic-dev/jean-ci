import { randomUUID } from 'node:crypto';
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
  persist: typeof updateCheckRun = updateCheckRun,
  durablePublication = true,
  beforeAttempt?: () => Promise<void>,
) {
  const completedAt = new Date();
  const updates = {
    status: 'completed',
    conclusion: payload.conclusion,
    completed_at: completedAt.toISOString(),
    details_url: `${BASE_URL}/checks/${dbId}`,
    output: { title: payload.title, summary: boundReviewMarkdown(payload.summary, 65535, `${BASE_URL}/checks/${dbId}`) },
  };
  const result = {
    status: 'completed',
    conclusion: payload.conclusion,
    title: payload.title,
    summary: payload.diagnostics ?? payload.summary,
    completed_at: completedAt,
  };
  if (!durablePublication) {
    // Explicit restarts retain their lock-session persistence fence: no local
    // verdict can survive owner loss while GitHub publication is in flight.
    try {
      await updateCheck(octokit, owner, repo, checkRunId, updates, { beforeAttempt });
    } catch (error: any) {
      // This write still uses the dedicated owner session and unfinished-check
      // guard. Owner loss must throw instead of retaining a late verdict.
      await persist(dbId, { ...result, github_completion: updates });
      console.error(`GitHub completion pending for ${owner}/${repo} check ${checkRunId} (db: ${dbId}, status: ${error?.status ?? 'unknown'})`);
      return;
    }
    await persist(dbId, result);
    return;
  }
  // Commit the terminal result and public outbox atomically before contacting
  // GitHub. A PATCH failure must not strand the row or overwrite a real verdict.
  await persist(dbId, { ...result, github_completion: updates });
  try {
    await updateCheck(octokit, owner, repo, checkRunId, updates, { beforeAttempt });
  } catch (error: any) {
    console.error(`GitHub completion pending for ${owner}/${repo} check ${checkRunId} (db: ${dbId}, status: ${error?.status ?? 'unknown'})`);
  }
  // The periodic reconciler verifies delivery and clears the outbox. It only
  // PATCHes this exact check ID; it never invokes the reviewer or posts reviews.
}

export interface RunPRReviewOptions {
  /** Optional subset of stable check identities to run (exact match, e.g. global:code-review or path:.jean-ci/pr-checks/...). */
  checkIdentities?: string[];
  /** Optional subset of check names to run (case-insensitive trimmed match). Omit to run all checks. */
  checkNames?: string[];
  /** When true with checkNames, require exactly one matched check (reject ambiguous legacy names). */
  requireSingleMatch?: boolean;
  /** Cooperative cancellation signal for caller-triggered reviews (e.g. MCP Tasks cancel). */
  signal?: AbortSignal;
  /** Optional async cooperative cancellation predicate (e.g. durable task status check). */
  isCancelled?: () => boolean | Promise<boolean>;
  onCheckCreated?: (info: { dbId: number; checkName: string; githubCheckId: number }) => void | Promise<void>;
  onCheckCompleted?: (info: { dbId: number; checkName: string; conclusion: 'success' | 'failure' | 'neutral'; title: string }) => void | Promise<void>;
  /** Optional MCP Events store override (primarily for testing). */
  mcpEventsStore?: import('./mcp/events.ts').McpEventsStore;
  /** Optional observer for emitted MCP Events (primarily for testing). */
  onMcpEvent?: (event: { eventId: string; name: string; data: Record<string, unknown> }) => void | Promise<void>;
}

export async function runPRReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  restart?: { checkId: number; checkName: string; checkIdentity?: string; assertOwner: () => Promise<void>; persist: typeof updateCheckRun },
  options?: RunPRReviewOptions,
) {
  const isRunCancelled = async (): Promise<boolean> => {
    if (options?.signal?.aborted) return true;
    if (!options?.isCancelled) return false;
    try {
      return Boolean(await options.isCancelled());
    } catch {
      return false;
    }
  };

  const repoFullName = `${owner}/${repo}`;
  const executionId = randomUUID();
  const checkIdentityByDbId = new Map<number, string>();
  const completedChecksForEvents: Array<{
    checkId: number;
    checkName: string;
    checkIdentity: string | null;
    conclusion: 'success' | 'failure' | 'neutral';
  }> = [];

  const emitMcpEvent = async (
    eventInput: {
      eventId: string;
      name: 'pr_review.completed' | 'pr_review.check_completed' | 'pr_review.approval_required';
      repo?: string | null;
      prNumber?: number | null;
      conclusion?: string | null;
      checkName?: string | null;
      data: Record<string, unknown>;
    },
  ) => {
    try {
      if (options?.onMcpEvent) {
        await options.onMcpEvent({
          eventId: eventInput.eventId,
          name: eventInput.name,
          data: eventInput.data,
        });
      }
      if (options?.mcpEventsStore || process.env.DATABASE_URL) {
        const { emitPrReviewMcpEventSafely } = await import('./mcp/events.ts');
        await emitPrReviewMcpEventSafely(eventInput, options?.mcpEventsStore);
      }
    } catch (eventErr: any) {
      console.warn(`Ignoring MCP event emission error (${eventInput.name}):`, eventErr?.message || eventErr);
    }
  };

  const persist = restart ? restart.persist : updateCheckRun;
  const complete = async (
    octokitArg: any,
    ownerArg: string,
    repoArg: string,
    checkRunIdArg: number,
    dbIdArg: number,
    payload: Parameters<typeof completeCheck>[5],
    checkName?: string,
  ) => {
    await restart?.assertOwner?.();
    await completeCheck(octokitArg, ownerArg, repoArg, checkRunIdArg, dbIdArg, payload, persist, !restart, restart?.assertOwner);
    // Isolate observer callback failures so a transient progress-store error can
    // never re-enter check error handling or overwrite an already-published verdict.
    if (checkName && options?.onCheckCompleted) {
      try {
        await options.onCheckCompleted({
          dbId: dbIdArg,
          checkName,
          conclusion: payload.conclusion,
          title: payload.title,
        });
      } catch (callbackError: any) {
        console.warn(`Ignoring onCheckCompleted callback failure for check "${checkName}" (db: ${dbIdArg}):`, callbackError?.message || callbackError);
      }
    }
    if (checkName) {
      const checkIdentity = checkIdentityByDbId.get(dbIdArg) ?? null;
      completedChecksForEvents.push({
        checkId: dbIdArg,
        checkName,
        checkIdentity,
        conclusion: payload.conclusion,
      });
      try {
        const { buildPrReviewCheckCompletedPayload } = await import('./mcp/events.ts');
        await emitMcpEvent(
          buildPrReviewCheckCompletedPayload({
            checkId: dbIdArg,
            repo: repoFullName,
            prNumber,
            headSha,
            checkName,
            checkIdentity,
            conclusion: payload.conclusion,
            executionId,
            baseUrl: BASE_URL,
          }),
        );
      } catch (eventErr: any) {
        console.warn(`Ignoring pr_review.check_completed event error for check "${checkName}" (db: ${dbIdArg}):`, eventErr?.message || eventErr);
      }
    }
  };
  const repoConfig = await getRepo(repoFullName);

  if (!repoConfig || !repoConfig.pr_review_enabled) {
    if (restart) throw new Error('Repository review disabled');
    console.log(`PR review disabled for ${repoFullName}`);
    return;
  }

  if (await isRunCancelled()) {
    console.log(`PR review cancelled before GitHub fetch for ${repoFullName}#${prNumber}`);
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
  const allChecks = normalizeChecks(userPrompt, checkFiles);
  let checks = allChecks.filter(c => !restart || (restart.checkIdentity ? c.identity === restart.checkIdentity : c.name === restart.checkName));
  if (restart && checks.length !== 1) throw new Error('The requested check is missing or its legacy name is ambiguous at the reviewed head');
  if (!restart && options?.checkIdentities && options.checkIdentities.length > 0) {
    const requestedIds = new Set(options.checkIdentities.map((id) => id.trim()).filter(Boolean));
    const availableIds = new Set(allChecks.map((c) => c.identity));
    const unknownIds = [...requestedIds].filter((id) => !availableIds.has(id));
    if (requestedIds.size === 0 || unknownIds.length > 0) {
      throw new Error(`Unknown check identity(ies) at ${headSha.slice(0, 7)}: ${unknownIds.join(', ')}. Available: ${allChecks.map((c) => c.identity).join(', ')}`);
    }
    checks = allChecks.filter((c) => requestedIds.has(c.identity));
  } else if (!restart && options?.checkNames && options.checkNames.length > 0) {
    const requested = new Set(options.checkNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
    const available = new Set(allChecks.map((c) => c.name.trim().toLowerCase()));
    const unknown = [...requested].filter((name) => !available.has(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown check name(s) at ${headSha.slice(0, 7)}: ${unknown.join(', ')}. Available: ${allChecks.map((c) => c.name).join(', ')}`);
    }
    checks = allChecks.filter((c) => requested.has(c.name.trim().toLowerCase()));
    if (options.requireSingleMatch && checks.length !== 1) {
      throw new Error(`Ambiguous legacy check name at ${headSha.slice(0, 7)}: matched ${checks.length} checks (${checks.map((c) => c.identity).join(', ')})`);
    }
  }

  if (await isRunCancelled()) {
    console.log(`PR review cancelled before creating checks for ${repoFullName}#${prNumber}`);
    return;
  }

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  const diffPreview = truncateReviewDiff(diff, DIFF_PREVIEW_LIMIT);

  // Create ALL checks as pending first, storing in DB
  const checkRuns = [];
  let failedCheckCreationCount = 0;
  let failedCheckPersistenceCount = 0;
  let cancelledDuringCreation = false;
  for (const check of checks) {
    if (await isRunCancelled()) {
      cancelledDuringCreation = true;
      break;
    }
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

      checkIdentityByDbId.set(dbId, check.identity);
      checkRuns.push({ check, checkRun, dbId });
      if (options?.onCheckCreated) {
        try {
          await options.onCheckCreated({ dbId, checkName: check.name, githubCheckId: checkRun.id });
        } catch (callbackError: any) {
          console.warn(`Ignoring onCheckCreated callback failure for check "${check.name}" (db: ${dbId}):`, callbackError?.message || callbackError);
        }
      }
      console.log(`Created pending check: ${check.name} (db: ${dbId})`);
    } catch (error: any) {
      if (restart) throw error;
      failedCheckCreationCount += 1;
      console.error(`Error creating check "${check.name}":`, error.message);
    }
  }

  // Run each check
  for (const { check, checkRun, dbId } of checkRuns) {
    if (await isRunCancelled()) {
      try {
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'neutral',
          title: '⚠️ Review cancelled',
          summary: 'Review run was cancelled by the caller before execution completed.',
        }, check.name);
      } catch (cancelErr: any) {
        failedCheckPersistenceCount += 1;
        console.error(`Failed to mark cancelled check "${check.name}":`, cancelErr?.message || cancelErr);
      }
      continue;
    }

    try {
      await restart?.assertOwner?.();
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
      }, { beforeAttempt: restart?.assertOwner });

      if (!check.isGlobal) {
        const promptValidation = validateReviewPrompt(check.prompt);
        if (!promptValidation.valid) {
          await complete(octokit, owner, repo, checkRun.id, dbId, {
            conclusion: 'failure',
            title: '❌ Invalid review prompt',
            summary: buildPromptValidationSummary(promptValidation.errors),
          }, check.name);
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
        source: { kind: 'github-pr', headSha: prInfo.head.sha, baseSha: prInfo.base?.sha },
      });
      const chunkedResponses = [];
      let executionFailure: ReturnType<typeof buildExecutionFailureOutcome> | null = null;
      let cancelledDuringCheck = false;
      const emittedApprovalKeys = new Set<string>();
      for (const [index, reviewContext] of reviewContexts.entries()) {
        if (await isRunCancelled()) {
          cancelledDuringCheck = true;
          break;
        }
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
              await persist(dbId, { status: 'in_progress', title, summary });
              try {
                await updateCheck(octokit, owner, repo, checkRun.id, {
                  status: 'in_progress', details_url: `${BASE_URL}/checks/${dbId}`,
                  output: { title, summary },
                }, { beforeAttempt: restart?.assertOwner });
                approvalWaitReported = true;
              } catch {
                await restart?.assertOwner?.();
                console.warn('Optional GitHub approval status unavailable; will retry while polling');
              }
            }
            const { postReviewApprovalComments } = await import('./review-approval-comments.ts');
            await postReviewApprovalComments(dbId);
            // Only a link and server-owned repo/SHA are sent, never tool text.
            const { notifyReviewApproval } = await import('./review-approvals.ts');
            await notifyReviewApproval(dbId);
            try {
              const { buildPrReviewApprovalRequiredPayload } = await import('./mcp/events.ts');
              const dbMod = await import('./db.ts');
              const bindings =
                typeof dbMod.reviewRunStore?.get === 'function'
                  ? await dbMod.reviewRunStore.get(dbId).catch(() => [])
                  : [];
              const pendingPrompts: Array<{
                segment: number;
                runId: string;
                executionGeneration: number;
                promptId: string;
              }> = [];
              for (const binding of bindings) {
                for (const prompt of binding.pending || []) {
                  pendingPrompts.push({
                    segment: binding.segment,
                    runId: binding.run_id ?? '',
                    executionGeneration: prompt.execution_generation,
                    promptId: prompt.prompt_id,
                  });
                }
              }
              if (pendingPrompts.length > 0) {
                for (const prompt of pendingPrompts) {
                  const approvalKey = `${prompt.segment}:${prompt.runId}:${prompt.executionGeneration}:${prompt.promptId}`;
                  if (emittedApprovalKeys.has(approvalKey)) continue;
                  emittedApprovalKeys.add(approvalKey);
                  await emitMcpEvent(
                    buildPrReviewApprovalRequiredPayload({
                      checkId: dbId,
                      repo: repoFullName,
                      prNumber,
                      headSha,
                      checkName: check.name,
                      approvalId: approvalKey,
                      segment: prompt.segment,
                      executionGeneration: prompt.executionGeneration,
                      promptId: prompt.promptId,
                      baseUrl: BASE_URL,
                    }),
                  );
                }
              } else {
                const fallbackKey = `fallback:${executionId}:${index + 1}`;
                if (!emittedApprovalKeys.has(fallbackKey)) {
                  emittedApprovalKeys.add(fallbackKey);
                  await emitMcpEvent(
                    buildPrReviewApprovalRequiredPayload({
                      checkId: dbId,
                      repo: repoFullName,
                      prNumber,
                      headSha,
                      checkName: check.name,
                      approvalId: fallbackKey,
                      segment: index + 1,
                      baseUrl: BASE_URL,
                    }),
                  );
                }
              }
            } catch (eventErr: any) {
              console.warn(`Ignoring pr_review.approval_required event error (db: ${dbId}):`, eventErr?.message || eventErr);
            }
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
      if (cancelledDuringCheck || await isRunCancelled()) {
        const priorFailure = chunkedResponses.find(({ parsed }) => parsed.verdict === 'FAIL');
        if (priorFailure) {
          const preservedFailure = combineChunkedReviewResponses(chunkedResponses);
          await complete(octokit, owner, repo, checkRun.id, dbId, {
            conclusion: 'failure',
            title: preservedFailure.title,
            summary: `${linkReviewedLocations(preservedFailure.reviewMarkdown, { owner, repo, headSha, diff })}\n\n${REVIEW_INTERRUPTION_NOTICE} [View full details](${BASE_URL}/checks/${dbId})`,
            diagnostics: withReviewInterruption(
              preservedFailure.normalized,
              'Review run was cancelled by the caller before remaining segments completed.',
            ),
          }, check.name);
          console.log(`Check "${check.name}" preserved an earlier blocking finding after caller cancellation`);
          continue;
        }
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'neutral',
          title: '⚠️ Review cancelled',
          summary: 'Review run was cancelled by the caller before publication.',
        }, check.name);
        console.log(`Check "${check.name}" cancelled before completion`);
        continue;
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
          }, check.name);
          console.log(`Check "${check.name}" preserved an earlier blocking finding after a later reviewer execution failure`);
          continue;
        }
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: executionFailure.conclusion,
          title: executionFailure.title,
          summary: `Reviewer execution did not finish. [View full details](${BASE_URL}/checks/${dbId})`,
          diagnostics: executionFailure.summary,
        }, check.name);
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
        }, check.name);
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
      }, check.name);

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error: any) {
      console.error(`Error running check "${check.name}":`, error.message);

      try {
        await complete(octokit, owner, repo, checkRun.id, dbId, {
          conclusion: 'failure',
          title: '❌ Check failed',
          summary: `Review run failed before completion.\n\n- ${error.message}`,
        }, check.name);
      } catch (updateError: any) {
        failedCheckPersistenceCount += 1;
        console.error('Failed to update check status:', updateError.message);
      }
    }
  }

  const expectedChecksCount = checks.length;
  const incompleteChecksCount = Math.max(0, expectedChecksCount - completedChecksForEvents.length);
  if (
    expectedChecksCount > 0 &&
    (completedChecksForEvents.length > 0 || failedCheckCreationCount > 0 || failedCheckPersistenceCount > 0)
  ) {
    const incompleteReason: 'failure' | 'cancelled' | undefined =
      incompleteChecksCount > 0
        ? failedCheckCreationCount > 0 || failedCheckPersistenceCount > 0 || !cancelledDuringCreation
          ? 'failure'
          : 'cancelled'
        : undefined;
    try {
      const { buildPrReviewCompletedPayload } = await import('./mcp/events.ts');
      await emitMcpEvent(
        buildPrReviewCompletedPayload({
          repo: repoFullName,
          prNumber,
          headSha,
          checks: completedChecksForEvents,
          expectedChecksCount,
          incompleteReason,
          executionId,
          baseUrl: BASE_URL,
        }),
      );
    } catch (eventErr: any) {
      console.warn(`Ignoring pr_review.completed event error for ${repoFullName}#${prNumber}:`, eventErr?.message || eventErr);
    }
  }
}
