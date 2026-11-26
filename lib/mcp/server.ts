import * as z from 'zod/v4';
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  completable,
  createMcpHandler,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { APP_BASE_URL } from '../config.ts';
import type {
  CheckApprovalWaitSummary,
  CheckRun,
  CheckRunFilterOptions,
  CheckRunSummaryRecord,
  OpenPR,
  PRReviewState,
  PaginatedResult,
  Pipeline,
  Repo,
  RepoFeatureSession,
  RepoWithActivity,
  TaskStats,
  TaskSummary,
  WebhookEvent,
} from '../db.ts';
import type { LocalReviewRequest, LocalReviewResponse } from '../local-review.ts';
import type { RunPRReviewOptions } from '../pr-review.ts';
import { validateReviewPrompt } from '../review-output.ts';
import { REVIEW_INSPECTOR_URI, registerJeanCiAppResources } from './apps.ts';
import {
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  MCP_SERVER_VERSION,
} from './server-card.ts';
import { getJeanCiSkillCatalog } from './skills.ts';
import {
  TASKS_EXTENSION_ID,
  clientSupportsTasks,
  createDbMcpTaskStore,
  createWorkingMcpTask,
  defaultMcpTaskAbortRegistry,
  registerMcpTasksExtension,
  safeUpdateMcpTask,
  toCreateTaskToolResult,
  type McpTaskAbortRegistry,
  type McpTaskStore,
} from './tasks.ts';

const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_REF_REGEX = /^[A-Za-z0-9._/-]+$/;

const RepoSlugSchema = z
  .string()
  .trim()
  .regex(REPO_SLUG_REGEX, 'Repository must be in owner/repo format');

export interface PrInfoSnapshot {
  number: number;
  state: string;
  title?: string;
  draft?: boolean;
  html_url?: string;
  head: { sha: string; ref?: string };
  base?: { sha?: string; ref?: string };
}

export interface RepoCheckFile {
  name: string;
  path?: string;
  content: string;
}

export interface JeanCiMcpDeps {
  baseUrl: string;
  taskStore: McpTaskStore;
  taskAbortRegistry: McpTaskAbortRegistry;
  getRepo: (fullName: string) => Promise<Repo | null>;
  getReposWithActivity: () => Promise<RepoWithActivity[]>;
  getOpenPRsFromEvents: () => Promise<OpenPR[]>;
  getCheckRunsFiltered: (options: CheckRunFilterOptions) => Promise<PaginatedResult<CheckRunSummaryRecord>>;
  getCheckRunsForPR: (repo: string, prNumber: number, headSha?: string) => Promise<CheckRunSummaryRecord[]>;
  getCheckRun: (id: number) => Promise<CheckRun | null>;
  getCheckApprovalSummary: (checkId: number) => Promise<CheckApprovalWaitSummary>;
  getPRReviewState: (repo: string, prNumber: number) => Promise<PRReviewState | null>;
  upsertPRReviewState: (data: {
    repo: string;
    pr_number: number;
    last_reviewed_sha?: string;
    is_draft: boolean;
    draft_reviewed: boolean;
  }) => Promise<void>;
  overrideCheckRunToPass: (id: number, reason: string, overriddenBy: string) => Promise<CheckRun | null>;
  getOpenPRsCount: () => Promise<number>;
  getPendingDeploymentsCount: () => Promise<number>;
  getTaskStats: () => Promise<TaskStats>;
  getTaskSummary: (repo?: string) => Promise<TaskSummary[]>;
  getTaskEvents: (options: {
    repo?: string;
    taskName?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ events: Array<{ output?: unknown; [key: string]: unknown }>; total: number }>;
  getCheckRunsByRepoCount: (repo: string) => Promise<number>;
  getDeploymentsByRepoCount: (repo: string) => Promise<number>;
  getEventsByRepoCount: (repo: string) => Promise<number>;
  getDeploymentPipelines: (page?: number, limit?: number) => Promise<PaginatedResult<Pipeline>>;
  getDeploymentPipelinesByRepo: (repo: string, page?: number, limit?: number) => Promise<PaginatedResult<Pipeline>>;
  getDeploymentsByRepoPaginated: (repo: string, page?: number, limit?: number) => Promise<PaginatedResult<Record<string, unknown>>>;
  getRecentEventsPaginated: (
    page?: number,
    limit?: number,
    eventType?: string,
    repo?: string,
  ) => Promise<PaginatedResult<WebhookEvent>>;
  getRepoFeatureSessions: (repoFullName: string) => Promise<RepoFeatureSession[]>;
  getDefaultUserPrompt: () => Promise<string>;
  getPRInfo: (installationId: number, owner: string, repo: string, prNumber: number) => Promise<PrInfoSnapshot>;
  getRepoDefaultBranch: (installationId: number, owner: string, repo: string) => Promise<string>;
  fetchPRCheckFiles: (installationId: number, owner: string, repo: string, ref: string) => Promise<RepoCheckFile[]>;
  runPRReview: (
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    options?: RunPRReviewOptions,
  ) => Promise<void>;
  runLocalReview: (input: LocalReviewRequest) => Promise<LocalReviewResponse>;
}

let defaultDepsCache: JeanCiMcpDeps | null = null;

export function createDefaultMcpDeps(): JeanCiMcpDeps {
  if (defaultDepsCache) return defaultDepsCache;
  const taskStore = createDbMcpTaskStore();

  defaultDepsCache = {
    baseUrl: APP_BASE_URL,
    taskStore,
    taskAbortRegistry: defaultMcpTaskAbortRegistry,
    getRepo: async (fullName) => (await import('../db.ts')).getRepo(fullName),
    getReposWithActivity: async () => (await import('../db.ts')).getReposWithActivity(),
    getOpenPRsFromEvents: async () => (await import('../db.ts')).getOpenPRsFromEvents(),
    getCheckRunsFiltered: async (opts) => (await import('../db.ts')).getCheckRunsFiltered(opts),
    getCheckRunsForPR: async (repo, prNumber, headSha) => (await import('../db.ts')).getCheckRunsForPR(repo, prNumber, headSha),
    getCheckRun: async (id) => (await import('../db.ts')).getCheckRun(id),
    getCheckApprovalSummary: async (id) => (await import('../db.ts')).getCheckApprovalSummary(id),
    getPRReviewState: async (repo, prNumber) => (await import('../db.ts')).getPRReviewState(repo, prNumber),
    upsertPRReviewState: async (data) => (await import('../db.ts')).upsertPRReviewState(data),
    overrideCheckRunToPass: async (id, reason, actor) => (await import('../db.ts')).overrideCheckRunToPass(id, reason, actor),
    getOpenPRsCount: async () => (await import('../db.ts')).getOpenPRsCount(),
    getPendingDeploymentsCount: async () => (await import('../db.ts')).getPendingDeploymentsCount(),
    getTaskStats: async () => (await import('../db.ts')).getTaskStats(),
    getTaskSummary: async (repo) => (await import('../db.ts')).getTaskSummary(repo),
    getTaskEvents: async (opts) =>
      (await import('../db.ts')).getTaskEvents(opts) as unknown as Promise<{
        events: Array<{ output?: unknown; [key: string]: unknown }>;
        total: number;
      }>,
    getCheckRunsByRepoCount: async (repo) => (await import('../db.ts')).getCheckRunsByRepoCount(repo),
    getDeploymentsByRepoCount: async (repo) => (await import('../db.ts')).getDeploymentsByRepoCount(repo),
    getEventsByRepoCount: async (repo) => (await import('../db.ts')).getEventsByRepoCount(repo),
    getDeploymentPipelines: async (page, limit) => (await import('../db.ts')).getDeploymentPipelines(page, limit),
    getDeploymentPipelinesByRepo: async (repo, page, limit) => (await import('../db.ts')).getDeploymentPipelinesByRepo(repo, page, limit),
    getDeploymentsByRepoPaginated: async (repo, page, limit) => (await import('../db.ts')).getDeploymentsByRepoPaginated(repo, page, limit),
    getRecentEventsPaginated: async (page, limit, eventType, repo) =>
      (await import('../db.ts')).getRecentEventsPaginated(page, limit, eventType, repo),
    getRepoFeatureSessions: async (repoFullName) => (await import('../db.ts')).getRepoFeatureSessions(repoFullName),
    getDefaultUserPrompt: async () => {
      const db = await import('../db.ts');
      return (await db.getConfig('user_prompt')) || db.DEFAULT_USER_PROMPT;
    },
    getPRInfo: async (installationId, owner, repo, prNumber) => {
      const gh = await import('../github.ts');
      const octokit = await gh.getInstallationOctokit(installationId);
      return gh.getPRInfo(octokit, owner, repo, prNumber);
    },
    getRepoDefaultBranch: async (installationId, owner, repo) => {
      const gh = await import('../github.ts');
      const octokit = await gh.getInstallationOctokit(installationId);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      return String(data.default_branch || 'main');
    },
    fetchPRCheckFiles: async (installationId, owner, repo, ref) => {
      const gh = await import('../github.ts');
      const octokit = await gh.getInstallationOctokit(installationId);
      return gh.fetchPRCheckFiles(octokit, owner, repo, ref, { strict: true });
    },
    runPRReview: async (installationId, owner, repo, prNumber, headSha, options) => {
      const { runPRReview } = await import('../pr-review.ts');
      await runPRReview(installationId, owner, repo, prNumber, headSha, undefined, options);
    },
    runLocalReview: async (input) => {
      const { runLocalReview } = await import('../local-review.ts');
      return runLocalReview(input);
    },
  };
  return defaultDepsCache;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function supportsFormElicitation(capabilities?: ClientCapabilities | null): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function serializeCheckSummary(check: CheckRunSummaryRecord, baseUrl: string) {
  return {
    id: check.id,
    githubCheckId: check.github_check_id ?? null,
    repo: check.repo,
    prNumber: check.pr_number,
    checkName: check.check_name,
    checkIdentity: check.check_identity ?? null,
    headSha: check.head_sha ?? null,
    status: check.status,
    conclusion: check.conclusion ?? null,
    title: check.title ?? null,
    prTitle: check.pr_title ?? null,
    manuallyOverridden: Boolean(check.manually_overridden),
    overrideReason: check.override_reason ?? null,
    overriddenBy: check.overridden_by ?? null,
    overriddenAt: iso(check.overridden_at),
    createdAt: iso(check.created_at),
    completedAt: iso(check.completed_at),
    detailsUrl: `${baseUrl}/checks/${check.id}`,
    prUrl: `https://github.com/${check.repo}/pull/${check.pr_number}`,
  };
}

function computePrRollup(
  latestChecks: ReturnType<typeof serializeCheckSummary>[],
  reviewState: PRReviewState | null,
  missingChecks: Array<{ identity: string; name: string }> = [],
  coverageUnverified = false,
): 'passing' | 'failing' | 'in_progress' | 'neutral' | 'stale' | 'pending' {
  if (latestChecks.length === 0) return 'pending';
  const expectedSha = reviewState?.last_reviewed_sha || null;
  if (expectedSha && latestChecks.some((c) => c.headSha && c.headSha !== expectedSha)) {
    return 'stale';
  }
  if (latestChecks.some((c) => c.status !== 'completed')) {
    return 'in_progress';
  }
  if (latestChecks.some((c) => c.conclusion === 'failure' && !c.manuallyOverridden)) {
    return 'failing';
  }
  if (missingChecks.length > 0) {
    return 'pending';
  }
  if (coverageUnverified) {
    return 'neutral';
  }
  if (latestChecks.every((c) => c.conclusion === 'success' || c.manuallyOverridden)) {
    return 'passing';
  }
  return 'neutral';
}

function sanitizeDeploymentEvent(row: Record<string, unknown>) {
  const rawPayload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  const eventType = typeof row.event_type === 'string' ? row.event_type : null;
  const isTaskEvent = Boolean(eventType && eventType.startsWith('coolify_task_'));

  return {
    id: row.id ?? null,
    eventType,
    deliveryId: typeof row.delivery_id === 'string' ? row.delivery_id : null,
    repo: typeof row.repo === 'string' ? row.repo : null,
    action: typeof row.action === 'string' ? row.action : null,
    source: typeof row.source === 'string' ? row.source : null,
    processed: Boolean(row.processed),
    createdAt: iso(row.created_at as Date | string | null | undefined),
    applicationUuid:
      typeof rawPayload?.application_uuid === 'string'
        ? rawPayload.application_uuid
        : typeof rawPayload?.app_uuid === 'string'
          ? rawPayload.app_uuid
          : null,
    applicationName:
      typeof rawPayload?.application_name === 'string'
        ? rawPayload.application_name
        : typeof rawPayload?.app_name === 'string'
          ? rawPayload.app_name
          : null,
    deploymentUuid: typeof rawPayload?.deployment_uuid === 'string' ? rawPayload.deployment_uuid : null,
    taskName: isTaskEvent && typeof rawPayload?.task_name === 'string' ? rawPayload.task_name : null,
    status: typeof rawPayload?.status === 'string' ? rawPayload.status : null,
    url: typeof rawPayload?.url === 'string' ? rawPayload.url : null,
    payloadRedacted: true,
  };
}

function sanitizeWebhookEvent(row: WebhookEvent & { source?: string | null }) {
  return {
    id: row.id,
    eventType: row.event_type,
    deliveryId: row.delivery_id ?? null,
    repo: row.repo ?? null,
    action: row.action ?? null,
    processed: Boolean(row.processed),
    source: row.source ?? null,
    createdAt: iso(row.created_at),
  };
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function jsonToolResult(summaryText: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: summaryText }],
    structuredContent,
  };
}

function splitSlug(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  return [owner, name];
}

function formatCheckLine(c: ReturnType<typeof serializeCheckSummary>): string {
  const verdict = c.manuallyOverridden
    ? 'OVERRIDDEN->PASS'
    : c.status === 'completed'
      ? (c.conclusion || 'completed').toUpperCase()
      : c.status.toUpperCase();
  const sha = c.headSha ? c.headSha.slice(0, 7) : 'n/a';
  return `- #${c.id} **${c.checkName}** [${verdict}] (${c.repo}#${c.prNumber} @ \`${sha}\`)${c.title ? ` — ${c.title}` : ''}`;
}

export async function createJeanCiMcpServer(
  partialDeps?: Partial<JeanCiMcpDeps>,
  requestCtx?: McpRequestContext,
): Promise<McpServer> {
  const deps: JeanCiMcpDeps = { ...createDefaultMcpDeps(), ...partialDeps };
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const ownerSubject = requestCtx?.authInfo?.clientId || 'anonymous';
  const actorLabel =
    (typeof requestCtx?.authInfo?.extra?.actor === 'string' && requestCtx.authInfo.extra.actor) ||
    ownerSubject;

  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      title: MCP_SERVER_TITLE,
      version: MCP_SERVER_VERSION,
      description: MCP_SERVER_DESCRIPTION,
      websiteUrl: baseUrl,
    },
    {
      instructions: [
        'Jean CI MCP Server for inspecting, retriggering, overriding, and running automated PR reviews, plus querying CI pipelines, deployments, tasks, and webhook events.',
        'Start PR triage with list_open_prs or get_pr_reviews, then inspect individual check findings via get_review_check.',
        'Before pushing fixes, use run_local_review to verify your diff against the repository checks. Use retrigger_pr_review to re-run GitHub checks on an open PR.',
        'Security boundary: Hermes reviewer tool-approval decisions (Approve once / Deny) require a GitHub-admin browser session at /checks/<id> and are intentionally not exposed as MCP actions.',
      ].join(' '),
      cacheHints: {
        'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
        'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
        'prompts/list': { ttlMs: 300_000, cacheScope: 'public' },
        'resources/list': { ttlMs: 60_000, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 300_000, cacheScope: 'public' },
        'resources/read': { ttlMs: 5_000, cacheScope: 'private' },
      },
    },
  );

  // 1. Official Extension: MCP Apps (io.modelcontextprotocol/ui)
  registerJeanCiAppResources(server);

  // 2. Official Extension: MCP Tasks (io.modelcontextprotocol/tasks)
  registerMcpTasksExtension(server, {
    taskStore: deps.taskStore,
    ownerSubject,
    abortRegistry: deps.taskAbortRegistry,
  });

  // 3. Official Extension: Skills over MCP (io.modelcontextprotocol/skills)
  const skillCatalog = await getJeanCiSkillCatalog();
  skillCatalog.attach(server);

  // =========================================================================
  // TOOLS (registered in deterministic alphabetical order for prompt caching)
  // =========================================================================

  // 1. get_ci_stats
  server.registerTool(
    'get_ci_stats',
    {
      title: 'Get CI Stats',
      description: 'Get global Jean CI health and statistics (open PR count, pending deployments, and scheduled task metrics).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const [openPRs, pendingDeploys, tasks] = await Promise.all([
        deps.getOpenPRsCount(),
        deps.getPendingDeploymentsCount(),
        deps.getTaskStats(),
      ]);
      const data = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        openPRs,
        pendingDeploys,
        tasks,
      };
      return jsonToolResult(
        `Jean CI status: **ok** — ${openPRs} open PR(s), ${pendingDeploys} pending deployment(s), ${tasks.total_tasks} scheduled task(s) (${tasks.failures_24h} failure(s) in 24h).`,
        data,
      );
    },
  );

  // 2. get_pr_reviews (MCP App UI enabled!)
  registerAppTool(
    server,
    'get_pr_reviews',
    {
      title: 'Get PR Reviews',
      description:
        'Inspect all Jean CI review checks, latest verdict rollup, and review tracking state for a specific pull request.',
      inputSchema: z.object({
        repo: RepoSlugSchema.describe('Repository slug in owner/repo format'),
        prNumber: z.number().int().positive().describe('Pull request number'),
        headSha: z
          .string()
          .trim()
          .regex(/^[a-fA-F0-9]{4,64}$/, 'headSha must be a hexadecimal commit SHA prefix or full SHA')
          .optional()
          .describe('Optional commit SHA (full or prefix) to filter checks for a specific commit'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: REVIEW_INSPECTOR_URI },
      },
    },
    async ({ repo, prNumber, headSha }) => {
      const [repoConfig, reviewState, rawChecks] = await Promise.all([
        deps.getRepo(repo),
        deps.getPRReviewState(repo, prNumber),
        deps.getCheckRunsForPR(repo, prNumber, headSha),
      ]);

      const allChecks = rawChecks.map((c) => serializeCheckSummary(c, baseUrl));
      // Keep full history in allChecks, but derive current latestChecks and rollup
      // from the active reviewed head so removed/renamed historical checks from
      // earlier commits do not pin the PR to "stale" indefinitely.
      let checksForRollup = allChecks;
      let targetSha: string | null = headSha ?? null;
      if (!headSha && allChecks.length > 0) {
        const reviewedSha = reviewState?.last_reviewed_sha || null;
        if (reviewedSha) {
          const atReviewedHead = allChecks.filter((c) => c.headSha === reviewedSha);
          if (atReviewedHead.length > 0) {
            checksForRollup = atReviewedHead;
            targetSha = reviewedSha;
          } else {
            const newestSha = allChecks.find((c) => c.headSha)?.headSha ?? null;
            if (newestSha) {
              checksForRollup = allChecks.filter((c) => c.headSha === newestSha);
              targetSha = newestSha;
            }
          }
        } else {
          const newestSha = allChecks.find((c) => c.headSha)?.headSha ?? null;
          if (newestSha) {
            checksForRollup = allChecks.filter((c) => c.headSha === newestSha);
            targetSha = newestSha;
          }
        }
      } else if (!targetSha) {
        targetSha = reviewState?.last_reviewed_sha ?? null;
      }

      // Group by stable check_identity (falling back to checkName for legacy rows)
      // so a custom check named "Code Review" never masks the global Code Review check.
      const latestByIdentity = new Map<string, ReturnType<typeof serializeCheckSummary>>();
      for (const check of checksForRollup) {
        const key = check.checkIdentity || check.checkName;
        if (!latestByIdentity.has(key)) {
          latestByIdentity.set(key, check);
        }
      }
      const latestChecks = [...latestByIdentity.values()];

      // Verify coverage against checks defined at the active reviewed head so a
      // passing subset retrigger (e.g. only "security") cannot mask a missing
      // always-on global Code Review or missing custom check.
      const expectedChecks: Array<{ identity: string; name: string }> = [
        { identity: 'global:code-review', name: 'Code Review' },
      ];
      let expectedChecksVerified = false;
      if (repoConfig?.pr_review_enabled && targetSha) {
        try {
          const [owner, repoName] = splitSlug(repo);
          const checkFiles = await deps.fetchPRCheckFiles(repoConfig.installation_id, owner, repoName, targetSha);
          for (const file of checkFiles.slice().sort((a, b) => a.name.localeCompare(b.name))) {
            expectedChecks.push({
              identity: `path:${file.path ?? `.jean-ci/pr-checks/${file.name}.md`}`,
              name: file.name,
            });
          }
          expectedChecksVerified = true;
        } catch {
          // Keep at minimum the always-on global Code Review requirement if GitHub is unavailable.
        }
      }

      const missingChecks = repoConfig?.pr_review_enabled
        ? expectedChecks.filter((expected) => {
            if (latestByIdentity.has(expected.identity)) return false;
            // Match legacy check rows that predate check_identity only when no row has checkIdentity set.
            return !latestChecks.some((c) => !c.checkIdentity && c.checkName === expected.name);
          })
        : [];

      const coverageUnverified = Boolean(repoConfig?.pr_review_enabled) && !expectedChecksVerified;
      const overallStatus = computePrRollup(latestChecks, reviewState, missingChecks, coverageUnverified);

      const data = {
        repo,
        prNumber,
        prUrl: `https://github.com/${repo}/pull/${prNumber}`,
        repoTracked: Boolean(repoConfig),
        prReviewEnabled: Boolean(repoConfig?.pr_review_enabled),
        overallStatus,
        reviewedHeadSha: targetSha,
        expectedChecksVerified,
        missingChecks,
        reviewState: reviewState
          ? {
              lastReviewedSha: reviewState.last_reviewed_sha ?? null,
              isDraft: Boolean(reviewState.is_draft),
              draftReviewed: Boolean(reviewState.draft_reviewed),
              updatedAt: iso(reviewState.updated_at),
            }
          : null,
        latestChecks,
        allChecks,
        totalRuns: allChecks.length,
      };

      const lines = [
        `### ${repo}#${prNumber} — Overall: **${overallStatus.toUpperCase()}**`,
        `- PR Review Enabled: ${data.prReviewEnabled ? 'yes' : 'no'}${data.repoTracked ? '' : ' (repository not tracked)'}`,
        ...(data.reviewState?.lastReviewedSha
          ? [`- Last Reviewed SHA: \`${data.reviewState.lastReviewedSha}\`${data.reviewState.isDraft ? ' (draft)' : ''}`]
          : []),
        ...(missingChecks.length > 0
          ? [`- Missing required checks at reviewed head: ${missingChecks.map((m) => `**${m.name}**`).join(', ')}`]
          : []),
        ...(coverageUnverified
          ? ['- Coverage: **UNVERIFIED** (could not retrieve `.jean-ci/pr-checks` definitions from GitHub for this head).']
          : []),
        `- Latest checks (${latestChecks.length}):`,
        ...(latestChecks.length > 0 ? latestChecks.map(formatCheckLine) : ['- None recorded yet.']),
      ];

      return jsonToolResult(lines.join('\n'), data);
    },
  );

  // 3. get_repo
  server.registerTool(
    'get_repo',
    {
      title: 'Get Repository Details',
      description: 'Get Jean CI tracking configuration and counts (checks, deployments, events) for a repository.',
      inputSchema: z.object({
        repo: RepoSlugSchema.describe('Repository slug in owner/repo format'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo }) => {
      const repoConfig = await deps.getRepo(repo);
      if (!repoConfig) {
        return toolError(`Repository not found: ${repo}`);
      }
      const [checks, deployments, events] = await Promise.all([
        deps.getCheckRunsByRepoCount(repo),
        deps.getDeploymentsByRepoCount(repo),
        deps.getEventsByRepoCount(repo),
      ]);
      const data = {
        repo: {
          id: repoConfig.id,
          fullName: repoConfig.full_name,
          installationId: repoConfig.installation_id,
          prReviewEnabled: Boolean(repoConfig.pr_review_enabled),
          featureSessionsEnabled: Boolean(repoConfig.feature_sessions_enabled),
          createdAt: iso(repoConfig.created_at),
          updatedAt: iso(repoConfig.updated_at),
        },
        counts: { checks, deployments, events },
      };
      return jsonToolResult(
        `**${repo}** — PR reviews: ${data.repo.prReviewEnabled ? 'enabled' : 'disabled'}, feature sessions: ${data.repo.featureSessionsEnabled ? 'enabled' : 'disabled'}. Counts: ${checks} checks, ${deployments} deployments, ${events} events.`,
        data,
      );
    },
  );

  // 4. get_review_check (MCP App UI enabled!)
  registerAppTool(
    server,
    'get_review_check',
    {
      title: 'Get Review Check Details',
      description:
        'Inspect a specific PR review check run by ID, including full review findings/summary, optional prompt and diff preview, override details, and safe read-only tool-approval wait status.',
      inputSchema: z.object({
        checkId: z.number().int().positive().describe('Jean CI numeric check run ID'),
        includePrompt: z.boolean().default(true).describe('Include the review criteria prompt used for this check'),
        includeDiff: z
          .boolean()
          .default(false)
          .describe('Include the stored unified diff preview (can be large; default false)'),
        maxDiffChars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .default(12_000)
          .describe('Maximum characters of diff_preview to return when includeDiff is true'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: REVIEW_INSPECTOR_URI },
      },
    },
    async ({ checkId, includePrompt, includeDiff, maxDiffChars }) => {
      const check = await deps.getCheckRun(checkId);
      if (!check) {
        return toolError(`Check run #${checkId} not found.`);
      }
      const rawApprovalStatus = await deps.getCheckApprovalSummary(checkId);
      const approvalStatus =
        check.status === 'completed'
          ? { ...rawApprovalStatus, waitingForApproval: false, pendingCount: 0 }
          : rawApprovalStatus;
      const rawDiff = check.diff_preview || '';
      const diffTruncated = includeDiff && rawDiff.length > maxDiffChars;
      const diffPreview = includeDiff ? rawDiff.slice(0, maxDiffChars) : null;
      const detailsUrl = `${baseUrl}/checks/${check.id}`;

      const serialized = {
        id: check.id,
        githubCheckId: check.github_check_id ?? null,
        repo: check.repo,
        prNumber: check.pr_number,
        checkName: check.check_name,
        checkIdentity: check.check_identity ?? null,
        headSha: check.head_sha ?? null,
        status: check.status,
        conclusion: check.conclusion ?? null,
        title: check.title ?? null,
        summary: check.summary ?? null,
        prTitle: check.pr_title ?? null,
        prBody: check.pr_body ?? null,
        prompt: includePrompt ? (check.prompt ?? null) : null,
        diffPreview,
        diffTruncated,
        diffTotalChars: rawDiff.length,
        manuallyOverridden: Boolean(check.manually_overridden),
        overrideReason: check.override_reason ?? null,
        overriddenBy: check.overridden_by ?? null,
        overriddenAt: iso(check.overridden_at),
        createdAt: iso(check.created_at),
        completedAt: iso(check.completed_at),
        detailsUrl,
        prUrl: `https://github.com/${check.repo}/pull/${check.pr_number}`,
      };

      const data = {
        check: serialized,
        approvalStatus: {
          ...approvalStatus,
          approvalPageUrl: approvalStatus.waitingForApproval ? detailsUrl : null,
          note: approvalStatus.waitingForApproval
            ? 'Human GitHub administrator approval is required in the authenticated browser UI. Tool commands and approval actions are intentionally not exposed over bearer-token MCP.'
            : null,
        },
      };

      const verdictLabel = serialized.manuallyOverridden
        ? 'OVERRIDDEN -> PASS'
        : serialized.status === 'completed'
          ? (serialized.conclusion || 'completed').toUpperCase()
          : serialized.status.toUpperCase();

      const lines = [
        `### Check #${serialized.id}: jean-ci / ${serialized.checkName} [${verdictLabel}]`,
        `- PR: ${serialized.repo}#${serialized.prNumber}${serialized.prTitle ? ` — ${serialized.prTitle}` : ''}`,
        `- Head SHA: \`${serialized.headSha || 'n/a'}\``,
        `- Details URL: ${detailsUrl}`,
      ];
      if (approvalStatus.waitingForApproval) {
        lines.push(
          `- **Tool Approval Required**: ${approvalStatus.pendingCount} pending request(s). Open ${detailsUrl} as a GitHub admin to approve once or deny.`,
        );
      }
      if (serialized.manuallyOverridden) {
        lines.push(
          `- **Manual Override**: recorded by ${serialized.overriddenBy || 'operator'} (${serialized.overrideReason || 'no reason'})`,
        );
      }
      if (serialized.summary) {
        lines.push('', '#### Review Summary', serialized.summary);
      }

      return jsonToolResult(lines.join('\n'), data);
    },
  );

  // 5. list_deployments
  server.registerTool(
    'list_deployments',
    {
      title: 'List Repository Deployments',
      description: 'List Coolify deployment events for a tracked repository (raw webhook payloads and scheduled task outputs are redacted).',
      inputSchema: z.object({
        repo: RepoSlugSchema.describe('Repository slug in owner/repo format'),
        page: z.number().int().min(1).default(1).describe('Page number (1-indexed)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Items per page (max 100)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, page, limit }) => {
      const result = await deps.getDeploymentsByRepoPaginated(repo, page, limit);
      const items = result.items.map((row) => sanitizeDeploymentEvent(row));
      return jsonToolResult(
        `Found ${result.total} deployment(s) for ${repo} (showing ${items.length} on page ${result.page}/${Math.max(1, result.totalPages)}).`,
        {
          items,
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      );
    },
  );

  // 6. list_events
  server.registerTool(
    'list_events',
    {
      title: 'List Webhook Events',
      description: 'List recent GitHub and Coolify webhook events recorded by Jean CI, optionally filtered by repo or eventType.',
      inputSchema: z.object({
        repo: RepoSlugSchema.optional().describe('Optional repository filter (owner/repo)'),
        eventType: z.string().trim().min(1).optional().describe('Optional webhook event type (e.g. pull_request, check_suite, issue_comment)'),
        page: z.number().int().min(1).default(1).describe('Page number (1-indexed)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Items per page (max 100)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, eventType, page, limit }) => {
      const result = await deps.getRecentEventsPaginated(page, limit, eventType, repo);
      const items = result.items.map((row) => sanitizeWebhookEvent(row));
      return jsonToolResult(
        `Found ${result.total} webhook event(s) (showing ${items.length} on page ${result.page}/${Math.max(1, result.totalPages)}).`,
        {
          items,
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      );
    },
  );

  // 7. list_feature_sessions
  server.registerTool(
    'list_feature_sessions',
    {
      title: 'List Feature Sessions',
      description: 'List tracked OpenClaw feature sessions for a repository with feature sessions enabled.',
      inputSchema: z.object({
        repo: RepoSlugSchema.describe('Repository slug in owner/repo format'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo }) => {
      const repoConfig = await deps.getRepo(repo);
      if (!repoConfig) {
        return toolError(`Repository not found: ${repo}`);
      }
      if (!repoConfig.feature_sessions_enabled) {
        return toolError(`Feature sessions are not enabled for ${repo}.`);
      }
      const sessions = await deps.getRepoFeatureSessions(repo);
      return jsonToolResult(
        `Found ${sessions.length} feature session(s) for ${repo}.`,
        { repo, items: sessions, total: sessions.length },
      );
    },
  );

  // 8. list_open_prs
  server.registerTool(
    'list_open_prs',
    {
      title: 'List Open Pull Requests',
      description:
        'List currently open PRs across repositories with PR review enabled, including their latest check status and whether the latest review matches the current PR head.',
      inputSchema: z.object({
        repo: RepoSlugSchema.optional().describe('Optional repository filter (owner/repo)'),
        status: z
          .enum(['pending', 'success', 'failure'])
          .optional()
          .describe('Optional filter by latest check status'),
        staleOnly: z
          .boolean()
          .default(false)
          .describe('When true, return only PRs whose latest review does not match the current head SHA'),
        page: z.number().int().min(1).default(1).describe('Page number (1-indexed)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Items per page (max 100)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, status, staleOnly, page, limit }) => {
      const allOpen = await deps.getOpenPRsFromEvents();
      const filtered = allOpen.filter((pr) => {
        if (repo && pr.repo !== repo) return false;
        if (status && pr.checkStatus !== status) return false;
        if (staleOnly && pr.latestReviewIsCurrent) return false;
        return true;
      });
      const total = filtered.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      const items = filtered.slice(offset, offset + limit).map((pr) => ({
        ...pr,
        latestReviewUrl: pr.latestReviewId ? `${baseUrl}/checks/${pr.latestReviewId}` : null,
      }));

      const lines = [
        `Found ${total} open PR(s) (page ${page}/${Math.max(1, totalPages)}):`,
        ...items.map(
          (pr) =>
            `- **${pr.repo}#${pr.number}** [${(pr.checkStatus || 'pending').toUpperCase()}] ${pr.title} (by ${pr.author}, \`${pr.headSha}\`${pr.latestReviewIsCurrent ? '' : ', review stale'}${pr.latestReviewId ? `, check #${pr.latestReviewId}` : ''})`,
        ),
      ];

      return jsonToolResult(lines.join('\n'), { items, total, page, limit, totalPages });
    },
  );

  // 9. list_pipelines
  server.registerTool(
    'list_pipelines',
    {
      title: 'List Deployment Pipelines',
      description: 'List CI/CD deployment pipelines (build -> package -> deploy) globally or for a specific repository.',
      inputSchema: z.object({
        repo: RepoSlugSchema.optional().describe('Optional repository filter (owner/repo)'),
        page: z.number().int().min(1).default(1).describe('Page number (1-indexed)'),
        limit: z.number().int().min(1).max(50).default(20).describe('Items per page (max 50)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, page, limit }) => {
      const result = repo
        ? await deps.getDeploymentPipelinesByRepo(repo, page, limit)
        : await deps.getDeploymentPipelines(page, limit);
      return jsonToolResult(
        `Found ${result.total} pipeline(s)${repo ? ` for ${repo}` : ''} (showing ${result.items.length} on page ${result.page}/${Math.max(1, result.totalPages)}).`,
        result as unknown as Record<string, unknown>,
      );
    },
  );

  // 10. list_pr_check_definitions
  server.registerTool(
    'list_pr_check_definitions',
    {
      title: 'List PR Check Definitions',
      description:
        'Inspect the active global Code Review prompt and all repository-specific .jean-ci/pr-checks/*.md prompts at a git ref (or default branch), including prompt validation status.',
      inputSchema: z.object({
        repo: RepoSlugSchema.describe('Repository slug in owner/repo format'),
        ref: z
          .string()
          .trim()
          .regex(GIT_REF_REGEX, 'Git ref contains invalid characters')
          .optional()
          .describe('Git branch, tag, or commit SHA to inspect (defaults to repository default branch)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ repo, ref }) => {
      const repoConfig = await deps.getRepo(repo);
      if (!repoConfig) {
        return toolError(`Repository is not tracked by Jean CI: ${repo}`);
      }
      const [owner, repoName] = splitSlug(repo);
      const resolvedRef = ref || (await deps.getRepoDefaultBranch(repoConfig.installation_id, owner, repoName));
      const [userPrompt, checkFiles] = await Promise.all([
        deps.getDefaultUserPrompt(),
        deps.fetchPRCheckFiles(repoConfig.installation_id, owner, repoName, resolvedRef),
      ]);

      const checks = [
        {
          name: 'Code Review',
          identity: 'global:code-review',
          isGlobal: true,
          path: null,
          valid: true,
          validationErrors: [] as string[],
          prompt: userPrompt,
        },
        ...checkFiles
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => {
            const validation = validateReviewPrompt(file.content);
            return {
              name: file.name,
              identity: `path:${file.path ?? `.jean-ci/pr-checks/${file.name}.md`}`,
              isGlobal: false,
              path: file.path ?? `.jean-ci/pr-checks/${file.name}.md`,
              valid: validation.valid,
              validationErrors: validation.errors,
              prompt: file.content,
            };
          }),
      ];

      const lines = [
        `PR check definitions for **${repo}** at \`${resolvedRef}\` (${checks.length} total, PR review ${repoConfig.pr_review_enabled ? 'enabled' : 'disabled'}):`,
        ...checks.map(
          (c) =>
            `- **${c.name}** (${c.isGlobal ? 'global always-on' : c.path}) — ${c.valid ? 'valid' : `INVALID: ${c.validationErrors.join('; ')}`}`,
        ),
      ];

      return jsonToolResult(lines.join('\n'), {
        repo,
        ref: resolvedRef,
        prReviewEnabled: Boolean(repoConfig.pr_review_enabled),
        checks,
      });
    },
  );

  // 11. list_pr_reviews
  server.registerTool(
    'list_pr_reviews',
    {
      title: 'List PR Review Checks',
      description:
        'List PR review check runs across Jean CI with optional filtering by repository, PR number, status, conclusion, check name, or commit SHA.',
      inputSchema: z.object({
        repo: RepoSlugSchema.optional().describe('Optional repository filter (owner/repo)'),
        prNumber: z.number().int().positive().optional().describe('Optional pull request number filter'),
        status: z.enum(['queued', 'in_progress', 'completed']).optional().describe('Optional status filter'),
        conclusion: z
          .enum(['success', 'failure', 'neutral', 'skipped'])
          .optional()
          .describe('Optional conclusion filter'),
        checkName: z.string().trim().min(1).optional().describe('Optional check name filter (e.g. "Code Review" or "security")'),
        headSha: z
          .string()
          .trim()
          .regex(/^[a-fA-F0-9]{4,64}$/, 'headSha must be a hexadecimal commit SHA prefix or full SHA')
          .optional()
          .describe('Optional commit SHA or prefix filter'),
        page: z.number().int().min(1).default(1).describe('Page number (1-indexed)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Items per page (max 100)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await deps.getCheckRunsFiltered(args);
      const items = result.items.map((c) => serializeCheckSummary(c, baseUrl));
      const lines = [
        `Found ${result.total} PR review check(s) (page ${result.page}/${Math.max(1, result.totalPages)}):`,
        ...items.map(formatCheckLine),
      ];
      return jsonToolResult(lines.join('\n'), {
        items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      });
    },
  );

  // 12. list_repos
  server.registerTool(
    'list_repos',
    {
      title: 'List Tracked Repositories',
      description: 'List all repositories tracked by Jean CI along with PR review enablement and recent activity.',
      inputSchema: z.object({
        prReviewEnabledOnly: z
          .boolean()
          .default(false)
          .describe('When true, include only repositories with PR review enabled'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ prReviewEnabledOnly }) => {
      const repos = await deps.getReposWithActivity();
      const filtered = prReviewEnabledOnly ? repos.filter((r) => r.pr_review_enabled) : repos;
      const lines = [
        `Found ${filtered.length} tracked repository/repositories:`,
        ...filtered.map(
          (r) => `- **${r.full_name}** — PR review: ${r.pr_review_enabled ? 'enabled' : 'disabled'}`,
        ),
      ];
      return jsonToolResult(lines.join('\n'), { items: filtered, total: filtered.length });
    },
  );

  // 13. list_tasks
  server.registerTool(
    'list_tasks',
    {
      title: 'List Scheduled Tasks',
      description: 'Get Coolify scheduled task summaries or task execution events (task outputs are redacted for bearer-token callers, matching the Public API).',
      inputSchema: z.object({
        view: z.enum(['summary', 'events']).default('summary').describe('Return aggregated task summary or individual task events'),
        repo: RepoSlugSchema.optional().describe('Optional repository filter (owner/repo)'),
        task: z.string().trim().min(1).optional().describe('Optional task name filter (events view)'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset (events view)'),
        limit: z.number().int().min(1).max(100).default(50).describe('Max items (events view)'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ view, repo, task, offset, limit }) => {
      if (view === 'summary') {
        const [summary, stats] = await Promise.all([deps.getTaskSummary(repo), deps.getTaskStats()]);
        const redacted = summary.map(({ last_output: _o, ...rest }) => ({
          ...rest,
          last_output: null,
          output_redacted: true,
        }));
        return jsonToolResult(
          `Found ${redacted.length} scheduled task(s) (${stats.runs_24h} runs / ${stats.failures_24h} failures in 24h).`,
          { summary: redacted, stats },
        );
      }

      const [{ events, total }, stats] = await Promise.all([
        deps.getTaskEvents({ repo, taskName: task, limit, offset }),
        deps.getTaskStats(),
      ]);
      const redacted = events.map(({ output: _o, ...rest }) => ({
        ...rest,
        output: null,
        output_redacted: true,
      }));
      return jsonToolResult(
        `Found ${total} scheduled task event(s) (showing ${redacted.length} from offset ${offset}).`,
        { events: redacted, total, stats, limit, offset },
      );
    },
  );

  // 14. override_pr_review (uses 2026-07-28 MRTR Form Elicitation when reason is omitted!)
  server.registerTool(
    'override_pr_review',
    {
      title: 'Override Failed PR Review Check',
      description:
        'Record a manual override to PASS for a failed completed check run inside Jean CI. Does not modify GitHub check runs or submit a GitHub approval review. If reason is omitted and the client supports form elicitation, prompts the user via MCP MRTR elicitation.',
      inputSchema: z.object({
        checkId: z.number().int().positive().describe('Numeric ID of the failed completed check run to override'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe('Audit reason for recording the manual override (prompted via elicitation if omitted)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ checkId, reason }, ctx) => {
      const checkRun = await deps.getCheckRun(checkId);
      if (!checkRun) {
        return toolError(`Check run #${checkId} not found.`);
      }
      if (checkRun.manually_overridden) {
        return toolError(`Check run #${checkId} was already manually overridden.`);
      }
      if (checkRun.status !== 'completed' || checkRun.conclusion !== 'failure') {
        return toolError(
          `Only failed completed checks can be overridden (check #${checkId} is ${checkRun.status}/${checkRun.conclusion || 'none'}).`,
        );
      }

      let resolvedReason = reason?.trim() || '';
      if (!resolvedReason) {
        const elicitResp = ctx.mcpReq.inputResponses?.override_confirmation as
          | { action?: string; content?: { reason?: string; confirm?: boolean } }
          | undefined;

        if (elicitResp) {
          if (elicitResp.action !== 'accept' || elicitResp.content?.confirm === false) {
            return toolError(`Manual override for check #${checkId} was cancelled by the user.`);
          }
          resolvedReason = String(elicitResp.content?.reason || '').trim();
        } else if (supportsFormElicitation(server.server.getClientCapabilities())) {
          return inputRequired({
            inputRequests: {
              override_confirmation: inputRequired.elicit({
                message: `Record a local Jean CI manual override to PASS for check #${checkId} (${checkRun.repo}#${checkRun.pr_number} / ${checkRun.check_name})? This does NOT update GitHub checks or submit a GitHub approval.`,
                requestedSchema: {
                  type: 'object',
                  properties: {
                    reason: {
                      type: 'string',
                      title: 'Override Reason',
                      description: 'Explain why this failed check is being overridden in Jean CI.',
                      minLength: 3,
                    },
                    confirm: {
                      type: 'boolean',
                      title: 'Confirm Local Override',
                      description: 'Acknowledge that this only records an override in Jean CI and does not change GitHub state.',
                      default: true,
                    },
                  },
                  required: ['reason', 'confirm'],
                },
              }),
            },
          });
        }
      }

      if (!resolvedReason) {
        return toolError('Override reason is required.');
      }

      const updated = await deps.overrideCheckRunToPass(checkId, resolvedReason, actorLabel);
      if (!updated) {
        return toolError(`Check run #${checkId} changed before override could be recorded.`);
      }

      const warning =
        'Manual override is recorded in jean-ci only. It does not update the GitHub check run or submit a GitHub approval review.';
      const data = {
        ok: true,
        check: serializeCheckSummary(updated, baseUrl),
        warning,
      };
      return jsonToolResult(
        `Recorded manual override on check #${updated.id} (${updated.repo}#${updated.pr_number} / ${updated.check_name}) by \`${actorLabel}\`.\n\n**Reason:** ${resolvedReason}\n\n> ${warning}`,
        data,
      );
    },
  );

  // 15. retrigger_pr_review (MCP Tasks enabled!)
  server.registerTool(
    'retrigger_pr_review',
    {
      title: 'Retrigger PR Review',
      description:
        'Retrigger Jean CI PR review check(s) on an open pull request. Provide either repo + prNumber or an existing checkId. Supports running all checks or a specific checkNames subset, and upgrades to an MCP Task (io.modelcontextprotocol/tasks) when the client supports Tasks.',
      inputSchema: z
        .object({
          repo: RepoSlugSchema.optional().describe('Repository slug in owner/repo format (required unless checkId is provided)'),
          prNumber: z.number().int().positive().optional().describe('Pull request number (required unless checkId is provided)'),
          checkId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Existing check run ID to resolve repo, PR number, and (when onlyThisCheck is true) the check name'),
          onlyThisCheck: z
            .boolean()
            .default(false)
            .describe('When checkId is supplied, retrigger only that specific check name instead of all checks on the PR'),
          checkNames: z
            .array(z.string().trim().min(1))
            .optional()
            .describe('Optional subset of check names to retrigger (e.g. ["Code Review", "security"])'),
          expectedHeadSha: z
            .string()
            .trim()
            .regex(/^[a-fA-F0-9]{7,64}$/, 'expectedHeadSha must be a valid hex commit SHA')
            .optional()
            .describe('Optional safety guard: refuse retrigger if the PR current head SHA on GitHub does not match'),
        })
        .refine((v) => v.checkId !== undefined || (v.repo !== undefined && v.prNumber !== undefined), {
          message: 'Provide either checkId or both repo and prNumber',
        }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ repo: inputRepo, prNumber: inputPrNumber, checkId, onlyThisCheck, checkNames, expectedHeadSha }) => {
      let targetRepo = inputRepo;
      let targetPrNumber = inputPrNumber;
      let targetCheckNames = checkNames && checkNames.length > 0 ? [...checkNames] : undefined;
      let targetCheckIdentities: string[] | undefined;
      let requireSingleMatch = false;
      let sourceCheck: CheckRun | null = null;

      if (checkId !== undefined) {
        sourceCheck = await deps.getCheckRun(checkId);
        if (!sourceCheck) {
          return toolError(`Check run #${checkId} not found.`);
        }
        targetRepo = targetRepo || sourceCheck.repo;
        targetPrNumber = targetPrNumber ?? sourceCheck.pr_number;
        if (onlyThisCheck && !targetCheckNames) {
          targetCheckNames = [sourceCheck.check_name];
          if (sourceCheck.check_identity) {
            targetCheckIdentities = [sourceCheck.check_identity];
          } else {
            requireSingleMatch = true;
          }
        }
      }

      if (!targetRepo || !targetPrNumber) {
        return toolError('Both repo and prNumber (or a valid checkId) are required.');
      }

      const repoConfig = await deps.getRepo(targetRepo);
      if (!repoConfig) {
        return toolError(`Repository is not tracked by Jean CI: ${targetRepo}`);
      }
      if (!repoConfig.pr_review_enabled) {
        return toolError(`PR review is disabled for ${targetRepo}. Enable it in Jean CI admin first.`);
      }

      const [owner, repoName] = splitSlug(targetRepo);
      const pr = await deps.getPRInfo(repoConfig.installation_id, owner, repoName, targetPrNumber);
      if (pr.state !== 'open') {
        return toolError(`Cannot retrigger review: ${targetRepo}#${targetPrNumber} is ${pr.state}, not open.`);
      }
      const headSha = pr.head?.sha;
      if (!headSha) {
        return toolError(`Could not determine head SHA for ${targetRepo}#${targetPrNumber}.`);
      }
      if (expectedHeadSha && !headSha.toLowerCase().startsWith(expectedHeadSha.toLowerCase())) {
        return toolError(
          `PR head SHA mismatch for ${targetRepo}#${targetPrNumber}: expected ${expectedHeadSha}, current GitHub head is ${headSha}.`,
        );
      }

      if ((targetCheckIdentities && targetCheckIdentities.length > 0) || (targetCheckNames && targetCheckNames.length > 0)) {
        let checkFiles: RepoCheckFile[];
        try {
          checkFiles = await deps.fetchPRCheckFiles(repoConfig.installation_id, owner, repoName, headSha);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(
            `Could not verify check definitions at ${headSha.slice(0, 7)} before retriggering: ${message}`,
          );
        }
        const availableChecks = [
          { identity: 'global:code-review', name: 'Code Review' },
          ...checkFiles
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((file) => ({
              identity: `path:${file.path ?? `.jean-ci/pr-checks/${file.name}.md`}`,
              name: file.name,
            })),
        ];

        if (targetCheckIdentities && targetCheckIdentities.length > 0) {
          const availableIds = new Set(availableChecks.map((c) => c.identity));
          const unknownIds = targetCheckIdentities.filter((id) => !availableIds.has(id));
          if (unknownIds.length > 0) {
            return toolError(
              `Unknown check identity(ies) at ${headSha.slice(0, 7)}: ${unknownIds.join(', ')}. Available: ${availableChecks.map((c) => c.identity).join(', ')}`,
            );
          }
        } else if (targetCheckNames && targetCheckNames.length > 0) {
          const availableNames = availableChecks.map((c) => c.name);
          const availableLower = new Set(availableNames.map((name) => name.trim().toLowerCase()));
          const requested = new Set(targetCheckNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
          const unknown = [...requested].filter((name) => !availableLower.has(name));
          if (requested.size === 0 || unknown.length > 0) {
            return toolError(
              `Unknown check name(s) at ${headSha.slice(0, 7)}: ${unknown.join(', ')}. Available: ${availableNames.join(', ')}`,
            );
          }
          if (requireSingleMatch) {
            const matched = availableChecks.filter((c) => requested.has(c.name.trim().toLowerCase()));
            if (matched.length !== 1) {
              return toolError(
                `Ambiguous legacy check name "${targetCheckNames[0]}" at ${headSha.slice(0, 7)} (matched ${matched.length} checks: ${matched.map((c) => c.identity).join(', ')}). Refusing to retrigger multiple checks.`,
              );
            }
          }
        }
      }

      const previousState = await deps.getPRReviewState(targetRepo, targetPrNumber);
      await deps.upsertPRReviewState({
        repo: targetRepo,
        pr_number: targetPrNumber,
        last_reviewed_sha: headSha,
        is_draft: Boolean(pr.draft),
        draft_reviewed: Boolean(pr.draft) || Boolean(previousState?.draft_reviewed),
      });

      const useTasks = clientSupportsTasks(server.server.getClientCapabilities());
      if (useTasks) {
        const task = await createWorkingMcpTask(deps.taskStore, {
          ownerSubject,
          toolName: 'retrigger_pr_review',
          statusMessage: `Running PR review checks for ${targetRepo}#${targetPrNumber} @ ${headSha.slice(0, 7)}`,
          metadata: {
            repo: targetRepo,
            prNumber: targetPrNumber,
            headSha,
            checkNames: targetCheckNames ?? null,
            checkIdentities: targetCheckIdentities ?? null,
          },
        });

        const abortController = deps.taskAbortRegistry.register(task.taskId);
        const isTaskCancelled = async (): Promise<boolean> => {
          if (abortController.signal.aborted) return true;
          try {
            const current = await deps.taskStore.get(task.taskId);
            return current?.status === 'cancelled';
          } catch {
            return false;
          }
        };

        const createdChecks: Array<{ dbId: number; checkName: string; githubCheckId: number; detailsUrl: string }> = [];
        const completedChecks: Array<{
          dbId: number;
          checkName: string;
          conclusion: 'success' | 'failure' | 'neutral';
          title: string;
          detailsUrl: string;
        }> = [];

        void (async () => {
          try {
            await deps.runPRReview(repoConfig.installation_id, owner, repoName, targetPrNumber, headSha, {
              checkIdentities: targetCheckIdentities,
              checkNames: targetCheckIdentities ? undefined : targetCheckNames,
              requireSingleMatch,
              signal: abortController.signal,
              isCancelled: isTaskCancelled,
              onCheckCreated: async ({ dbId, checkName, githubCheckId }) => {
                createdChecks.push({ dbId, checkName, githubCheckId, detailsUrl: `${baseUrl}/checks/${dbId}` });
                await safeUpdateMcpTask(deps.taskStore, task.taskId, {
                  statusMessage: `Queued ${createdChecks.length} check(s) for ${targetRepo}#${targetPrNumber}: ${createdChecks.map((c) => c.checkName).join(', ')}`,
                  metadata: { repo: targetRepo, prNumber: targetPrNumber, headSha, createdChecks, completedChecks },
                });
              },
              onCheckCompleted: async ({ dbId, checkName, conclusion, title }) => {
                completedChecks.push({
                  dbId,
                  checkName,
                  conclusion,
                  title,
                  detailsUrl: `${baseUrl}/checks/${dbId}`,
                });
                await safeUpdateMcpTask(deps.taskStore, task.taskId, {
                  statusMessage: `Completed ${completedChecks.length}/${Math.max(createdChecks.length, completedChecks.length)} check(s): ${completedChecks.map((c) => `${c.checkName}=${c.conclusion}`).join(', ')}`,
                  metadata: { repo: targetRepo, prNumber: targetPrNumber, headSha, createdChecks, completedChecks },
                });
              },
            });

            if (await isTaskCancelled()) return;

            const payload = {
              status: 'completed',
              repo: targetRepo,
              prNumber: targetPrNumber,
              headSha,
              sourceCheckId: sourceCheck?.id ?? null,
              checksRequested: targetCheckNames ?? ['all'],
              checkIdentitiesRequested: targetCheckIdentities ?? null,
              createdChecks,
              completedChecks,
              prUrl: pr.html_url || `https://github.com/${targetRepo}/pull/${targetPrNumber}`,
            };
            const summaryLines = [
              `Completed retriggered PR review for **${targetRepo}#${targetPrNumber}** @ \`${headSha.slice(0, 7)}\`.`,
              ...completedChecks.map(
                (c) => `- #${c.dbId} **${c.checkName}**: **${c.conclusion.toUpperCase()}** — ${c.title} (${c.detailsUrl})`,
              ),
            ];
            await safeUpdateMcpTask(deps.taskStore, task.taskId, {
              status: 'completed',
              statusMessage: `Finished ${completedChecks.length} check(s) for ${targetRepo}#${targetPrNumber}`,
              result: jsonToolResult(summaryLines.join('\n'), payload),
            });
          } catch (error: unknown) {
            if (await isTaskCancelled()) return;
            const message = error instanceof Error ? error.message : String(error);
            await safeUpdateMcpTask(deps.taskStore, task.taskId, {
              status: 'completed',
              statusMessage: `Review run failed: ${message}`,
              result: toolError(`Retriggered PR review failed for ${targetRepo}#${targetPrNumber}: ${message}`),
            });
          } finally {
            deps.taskAbortRegistry.unregister(task.taskId);
          }
        })().catch((unexpectedError) => {
          console.error(`[MCP Tasks] Unexpected failure in retrigger_pr_review task ${task.taskId}:`, unexpectedError);
        });

        return toCreateTaskToolResult(task);
      }

      // Graceful degradation for clients without io.modelcontextprotocol/tasks:
      // enqueue asynchronously and return immediately with clear inspection instructions.
      void deps
        .runPRReview(repoConfig.installation_id, owner, repoName, targetPrNumber, headSha, {
          checkIdentities: targetCheckIdentities,
          checkNames: targetCheckIdentities ? undefined : targetCheckNames,
          requireSingleMatch,
        })
        .catch((err) => console.error(`MCP retrigger_pr_review error (${targetRepo}#${targetPrNumber}):`, err));

      const data = {
        status: 'queued',
        repo: targetRepo,
        prNumber: targetPrNumber,
        headSha,
        sourceCheckId: sourceCheck?.id ?? null,
        headChangedFromSourceCheck: Boolean(sourceCheck?.head_sha && sourceCheck.head_sha !== headSha),
        checksRequested: targetCheckNames ?? ['all'],
        checkIdentitiesRequested: targetCheckIdentities ?? null,
        prUrl: pr.html_url || `https://github.com/${targetRepo}/pull/${targetPrNumber}`,
        message: `Queued PR review for ${targetRepo}#${targetPrNumber} @ ${headSha.slice(0, 7)}. Poll get_pr_reviews to inspect progress and results.`,
      };
      return jsonToolResult(data.message, data);
    },
  );

  // 16. run_local_review (MCP Tasks enabled!)
  server.registerTool(
    'run_local_review',
    {
      title: 'Run Local Diff Review',
      description:
        'Run Jean CI review checks (Code Review + git-backed .jean-ci/pr-checks/*.md) against a caller-provided unified git diff before pushing. Never auto-approves reviewer tools. Upgrades to an MCP Task when the client supports io.modelcontextprotocol/tasks.',
      inputSchema: z
        .object({
          repo: RepoSlugSchema.describe('Tracked repository slug in owner/repo format'),
          diff: z.string().min(1).describe('Unified git diff to review'),
          headSha: z
            .string()
            .trim()
            .regex(GIT_REF_REGEX, 'headSha contains invalid characters')
            .optional()
            .describe('Git ref/SHA used to load .jean-ci/pr-checks prompts (full immutable SHA anchors surrounding source)'),
          ref: z
            .string()
            .trim()
            .regex(GIT_REF_REGEX, 'ref contains invalid characters')
            .optional()
            .describe('Git ref used to load .jean-ci/pr-checks prompts when headSha is omitted'),
          title: z.string().optional().describe('Optional pull request or change title'),
          body: z.string().optional().describe('Optional pull request or change description'),
          selectedChecks: z
            .array(z.string().trim().min(1))
            .optional()
            .describe('Optional subset of git-backed check names to run. Code Review always runs.'),
        })
        .refine((v) => Boolean(v.headSha || v.ref), {
          message: 'Either headSha or ref is required',
        }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repo, diff, headSha, ref, title, body, selectedChecks }) => {
      const request: LocalReviewRequest = {
        repo,
        diff,
        headSha: headSha || null,
        ref: ref || null,
        title: title ?? null,
        body: body ?? null,
        selectedChecks,
      };

      const formatResult = (result: LocalReviewResponse): CallToolResult => {
        const lines = [
          `### Local Review for **${result.repo}**`,
          ...result.checks.map((c) => `- **${c.name}**: **${c.verdict}** — ${c.title}\n${c.summary}`),
          ...result.validationFailures.map((f) => `- **${f.name}** [VALIDATION FAILURE]: ${f.summary}`),
          ...result.executionFailures.map((f) => `- **${f.name}** [EXECUTION FAILURE (${f.errorType})]: ${f.error}`),
        ];
        return jsonToolResult(lines.join('\n\n'), result as unknown as Record<string, unknown>);
      };

      if (clientSupportsTasks(server.server.getClientCapabilities())) {
        const task = await createWorkingMcpTask(deps.taskStore, {
          ownerSubject,
          toolName: 'run_local_review',
          statusMessage: `Running local review for ${repo} against ${headSha || ref}`,
          metadata: { repo, ref: headSha || ref },
        });

        const abortController = deps.taskAbortRegistry.register(task.taskId);
        const isTaskCancelled = async (): Promise<boolean> => {
          if (abortController.signal.aborted) return true;
          try {
            const current = await deps.taskStore.get(task.taskId);
            return current?.status === 'cancelled';
          } catch {
            return false;
          }
        };

        void (async () => {
          try {
            const result = await deps.runLocalReview({
              ...request,
              signal: abortController.signal,
              isCancelled: isTaskCancelled,
            });
            if (await isTaskCancelled()) return;
            await safeUpdateMcpTask(deps.taskStore, task.taskId, {
              status: 'completed',
              statusMessage: `Local review completed for ${repo}: ${result.checks.length} check(s), ${result.executionFailures.length} execution failure(s)`,
              result: formatResult(result),
            });
          } catch (error: unknown) {
            if (await isTaskCancelled()) return;
            const message = error instanceof Error ? error.message : String(error);
            await safeUpdateMcpTask(deps.taskStore, task.taskId, {
              status: 'completed',
              statusMessage: `Local review failed: ${message}`,
              result: toolError(`Local review failed: ${message}`),
            });
          } finally {
            deps.taskAbortRegistry.unregister(task.taskId);
          }
        })().catch((unexpectedError) => {
          console.error(`[MCP Tasks] Unexpected failure in run_local_review task ${task.taskId}:`, unexpectedError);
        });

        return toCreateTaskToolResult(task);
      }

      try {
        const result = await deps.runLocalReview(request);
        return formatResult(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Local review failed';
        return toolError(message);
      }
    },
  );

  // =========================================================================
  // RESOURCES & RESOURCE TEMPLATES
  // =========================================================================

  server.registerResource(
    'ci-stats',
    'jean-ci://stats',
    {
      title: 'Jean CI Global Stats',
      description: 'Live snapshot of open PRs, pending deployments, and scheduled task metrics.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 10_000, cacheScope: 'private' },
    },
    async (uri) => {
      const [openPRs, pendingDeploys, tasks] = await Promise.all([
        deps.getOpenPRsCount(),
        deps.getPendingDeploymentsCount(),
        deps.getTaskStats(),
      ]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ openPRs, pendingDeploys, tasks }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'tracked-repos',
    'jean-ci://repos',
    {
      title: 'Tracked Repositories',
      description: 'All repositories tracked by Jean CI with PR review status and last activity.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 30_000, cacheScope: 'private' },
    },
    async (uri) => {
      const items = await deps.getReposWithActivity();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ items, total: items.length }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'open-prs',
    'jean-ci://prs/open',
    {
      title: 'Open Pull Requests',
      description: 'Open pull requests across PR-review-enabled repositories.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 10_000, cacheScope: 'private' },
    },
    async (uri) => {
      const items = await deps.getOpenPRsFromEvents();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ items, total: items.length }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'review-check',
    new ResourceTemplate('jean-ci://checks/{checkId}', { list: undefined }),
    {
      title: 'PR Review Check Run',
      description: 'Detailed JSON record for a single PR review check run including findings, prompt, override metadata, and safe approval status.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 5_000, cacheScope: 'private' },
    },
    async (uri, variables) => {
      const checkId = Number(variables.checkId);
      if (!Number.isSafeInteger(checkId) || checkId <= 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid checkId: ${String(variables.checkId)}`);
      }
      const check = await deps.getCheckRun(checkId);
      if (!check) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Check run #${checkId} not found`);
      }
      const approvalStatus = await deps.getCheckApprovalSummary(checkId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                check: {
                  ...serializeCheckSummary(check, baseUrl),
                  summary: check.summary ?? null,
                  prompt: check.prompt ?? null,
                  prBody: check.pr_body ?? null,
                },
                approvalStatus,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    'pr-reviews',
    new ResourceTemplate('jean-ci://repos/{owner}/{repo}/prs/{prNumber}/reviews', {
      list: undefined,
      complete: {
        owner: async (value) => {
          const repos = await deps.getReposWithActivity();
          const owners = [...new Set(repos.map((r) => r.full_name.split('/')[0]))];
          return owners.filter((o) => o.toLowerCase().startsWith(value.toLowerCase()));
        },
        repo: async (value, ctx) => {
          const ownerFilter = ctx?.arguments?.owner;
          const repos = await deps.getReposWithActivity();
          return repos
            .filter((r) => !ownerFilter || r.full_name.startsWith(`${ownerFilter}/`))
            .map((r) => r.full_name.split('/')[1])
            .filter((name) => name.toLowerCase().startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      title: 'PR Review History',
      description: 'All Jean CI check runs and review tracking state for a specific pull request.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 5_000, cacheScope: 'private' },
    },
    async (uri, variables) => {
      const owner = String(variables.owner || '');
      const repo = String(variables.repo || '');
      const fullName = `${owner}/${repo}`;
      const prNumber = Number(variables.prNumber);
      if (!REPO_SLUG_REGEX.test(fullName) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid PR resource URI: ${uri.href}`);
      }
      const [reviewState, checks] = await Promise.all([
        deps.getPRReviewState(fullName, prNumber),
        deps.getCheckRunsForPR(fullName, prNumber),
      ]);
      const serialized = checks.map((c) => serializeCheckSummary(c, baseUrl));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                repo: fullName,
                prNumber,
                reviewState,
                checks: serialized,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // =========================================================================
  // PROMPTS (with completable arguments!)
  // =========================================================================

  server.registerPrompt(
    'triage-pr-reviews',
    {
      title: 'Triage PR Reviews',
      description: 'Guide an assistant through inspecting, classifying, fixing, and retriggering Jean CI reviews for a pull request.',
      argsSchema: z.object({
        repo: completable(RepoSlugSchema.describe('Repository slug in owner/repo format'), async (value) => {
          const repos = await deps.getReposWithActivity();
          return repos
            .map((r) => r.full_name)
            .filter((name) => name.toLowerCase().startsWith(value.toLowerCase()))
            .slice(0, 20);
        }),
        prNumber: z.string().regex(/^[1-9]\d*$/, 'Must be a positive PR number').describe('Pull request number'),
      }),
    },
    ({ repo, prNumber }) => ({
      description: `Triage Jean CI PR reviews for ${repo}#${prNumber}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Inspect all Jean CI PR review checks for **${repo}#${prNumber}**.`,
              `1. Call \`get_pr_reviews\` with \`repo: "${repo}"\` and \`prNumber: ${prNumber}\`.`,
              `2. For each failing, incomplete, neutral, or in-progress check, call \`get_review_check\` to read the exact findings and check \`approvalStatus.waitingForApproval\`.`,
              `3. Group your report into:`,
              `   - Confirmed blocking findings (with file/line and smallest required fix)`,
              `   - Tool-approval waits (surface the authenticated \`/checks/<id>\` URL for a human admin; do NOT retrigger)`,
              `   - Transient failures / stale reviews safe to retrigger with \`retrigger_pr_review\``,
              `4. Recommend the exact next action.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'fix-review-findings',
    {
      title: 'Fix PR Review Findings',
      description: 'Inspect a failing Jean CI review check, implement the minimal blocking fixes, and verify locally via run_local_review.',
      argsSchema: z.object({
        checkId: z.string().regex(/^[1-9]\d*$/, 'Must be a positive numeric check ID').describe('Failing Jean CI check run ID'),
      }),
    },
    ({ checkId }) => ({
      description: `Resolve blocking findings from Jean CI check #${checkId}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Load Jean CI check #${checkId} using \`get_review_check\` (with \`checkId: ${checkId}\` and \`includePrompt: true\`).`,
              `Then:`,
              `1. List every confirmed blocking finding and its cited location.`,
              `2. Verify each finding against the local workspace code before editing.`,
              `3. Apply the minimal targeted fixes without unrelated refactoring.`,
              `4. Run \`run_local_review\` with our resulting \`git diff\` and the PR head SHA/ref to verify Jean CI now returns PASS.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'draft-pr-check-prompt',
    {
      title: 'Draft Custom PR Check Prompt',
      description: 'Author a valid .jean-ci/pr-checks/<name>.md review prompt that passes Jean CI prompt validation.',
      argsSchema: z.object({
        name: z.string().trim().min(1).describe('Short slug for the check file (e.g. security, migrations, api-parity)'),
        focus: z.string().trim().min(1).describe('Specific blocking risks this check should catch'),
      }),
    },
    ({ name, focus }) => ({
      description: `Draft .jean-ci/pr-checks/${name}.md`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Draft a custom Jean CI PR check prompt for \`.jean-ci/pr-checks/${name}.md\` focused on: **${focus}**.`,
              `Requirements:`,
              `- Include a Markdown H1 title (\`# ...\`)`,
              `- Include \`## Purpose\`, \`## Review Instructions\`, and \`## Verdict Criteria\``,
              `- Define explicit **PASS** and **FAIL** conditions in \`## Verdict Criteria\``,
              `- Keep findings strictly merge-blocking and pragmatic (no style nitpicks).`,
              `Optionally read the \`author-pr-check\` skill via MCP Skills if available.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseAllowedOrigins(baseUrl: string): Set<string> {
  const allowed = new Set<string>();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      allowed.add(parsed.origin);
    }
  } catch {
    // Ignore malformed base URL
  }
  const extra = process.env.MCP_ALLOWED_ORIGINS || '';
  for (const raw of extra.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        allowed.add(parsed.origin);
      }
    } catch {
      // Ignore invalid origin entries
    }
  }
  return allowed;
}

/**
 * Validates the HTTP Origin header per MCP Streamable HTTP DNS-rebinding rules.
 * Requests without an Origin header (CLI/SDK clients) are permitted; requests
 * carrying an untrusted Origin header are rejected with HTTP 403 Forbidden.
 */
export function validateMcpOrigin(request: Request, baseUrl: string = APP_BASE_URL): Response | null {
  const originHeader = request.headers.get('origin');
  if (!originHeader) return null;

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return new Response(JSON.stringify({ error: 'Forbidden: invalid Origin header' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'Forbidden: unsupported Origin scheme' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const allowedOrigins = parseAllowedOrigins(baseUrl);
  if (allowedOrigins.has(originUrl.origin)) {
    return null;
  }

  try {
    const requestUrl = new URL(request.url);
    if (
      LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase()) &&
      LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase())
    ) {
      return null;
    }
  } catch {
    // Fall through to 403
  }

  return new Response(JSON.stringify({ error: 'Forbidden: untrusted Origin header' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function checkTaskSubscriptionCapability(request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  if (request.headers.get('mcp-method')?.trim().toLowerCase() !== 'subscriptions/listen') {
    return null;
  }

  let parsed: {
    id?: string | number | null;
    method?: unknown;
    params?: {
      notifications?: { taskIds?: unknown };
      _meta?: Record<string, unknown>;
    };
  };
  try {
    parsed = (await request.clone().json()) as typeof parsed;
  } catch {
    return null;
  }

  if (parsed?.method !== 'subscriptions/listen') return null;
  if (parsed?.params?.notifications?.taskIds === undefined) return null;

  const clientCaps = parsed.params._meta?.['io.modelcontextprotocol/clientCapabilities'] as
    | ClientCapabilities
    | undefined;
  if (clientSupportsTasks(clientCaps)) return null;

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: parsed.id ?? null,
      error: {
        code: ProtocolErrorCode.MissingRequiredClientCapability,
        message: `Client must declare the "${TASKS_EXTENSION_ID}" capability before subscribing to task notifications.`,
        data: {
          requiredCapabilities: {
            extensions: {
              [TASKS_EXTENSION_ID]: {},
            },
          },
        },
      },
    }),
    {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}

export function createJeanCiMcpHandler(partialDeps?: Partial<JeanCiMcpDeps>): McpHttpHandler {
  const configuredBaseUrl = partialDeps?.baseUrl ?? APP_BASE_URL;
  const inner = createMcpHandler(
    async (ctx) => createJeanCiMcpServer(partialDeps, ctx),
    {
      // Support both 2026-07-28 (modern stateless) and 2025-11-25 (stateless fallback)
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: (error) => {
        console.error('[MCP] Handler error:', error.message);
      },
    },
  );

  return {
    ...inner,
    fetch: async (request, options) => {
      const originError = validateMcpOrigin(request, configuredBaseUrl);
      if (originError) return originError;

      const taskSubError = await checkTaskSubscriptionCapability(request);
      if (taskSubError) return taskSubError;

      return inner.fetch(request, options);
    },
  };
}
