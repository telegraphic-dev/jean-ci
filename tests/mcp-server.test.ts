import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createJeanCiMcpHandler, type JeanCiMcpDeps } from '../lib/mcp/server.ts';
import { InMemoryMcpTaskStore, McpTaskAbortRegistry } from '../lib/mcp/tasks.ts';
import { REVIEW_INSPECTOR_URI, RESOURCE_MIME_TYPE } from '../lib/mcp/apps.ts';
import {
  AI_CATALOG_MEDIA_TYPE,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_VERSIONS,
  SERVER_CARD_MEDIA_TYPE,
  buildAiCatalog,
  buildDiscoveryJsonResponse,
  buildMcpServerCard,
} from '../lib/mcp/server-card.ts';
import { summarizeCheckApprovalRuns, type CheckRun, type CheckRunSummaryRecord, type OpenPR, type Repo } from '../lib/db.ts';
import { fetchPRCheckFiles } from '../lib/github.ts';

function createFixtureDeps() {
  const taskStore = new InMemoryMcpTaskStore();
  const taskAbortRegistry = new McpTaskAbortRegistry();
  const repos: Repo[] = [
    {
      id: 1,
      full_name: 'telegraphic-dev/jean-ci',
      installation_id: 101,
      pr_review_enabled: true,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      id: 2,
      full_name: 'telegraphic-dev/disabled-repo',
      installation_id: 102,
      pr_review_enabled: false,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    },
  ];

  const checks: CheckRun[] = [
    {
      id: 42,
      github_check_id: 9001,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 171,
      check_name: 'Code Review',
      check_identity: 'global:code-review',
      head_sha: 'ad8ac61000000000000000000000000000000000',
      status: 'completed',
      conclusion: 'failure',
      title: '❌ Blocking issues found',
      summary: '**VERDICT: FAIL**\n\n### Missing null check\n\n**Location**: lib/foo.ts:12',
      prompt: '## Review Criteria\nCatch blocking bugs.',
      pr_title: 'fix: safely project encoded catalog data',
      pr_body: 'Ensures safe projection.',
      diff_preview: 'diff --git a/lib/foo.ts b/lib/foo.ts\n+const x = 1;',
      manually_overridden: false,
      created_at: new Date('2026-11-25T10:00:00.000Z'),
      completed_at: new Date('2026-11-25T10:01:00.000Z'),
    },
    {
      id: 43,
      github_check_id: 9002,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 171,
      check_name: 'security',
      check_identity: 'path:.jean-ci/pr-checks/security.md',
      head_sha: 'ad8ac61000000000000000000000000000000000',
      status: 'in_progress',
      conclusion: undefined,
      title: 'Tool approval required',
      summary: 'Review paused for an operator decision.',
      prompt: '# Security\n## Purpose\nSecurity\n## Review Instructions\nCheck.\n## Verdict Criteria\nPASS/FAIL',
      pr_title: 'fix: safely project encoded catalog data',
      pr_body: 'Ensures safe projection.',
      diff_preview: 'diff --git a/lib/foo.ts b/lib/foo.ts\n+const x = 1;',
      manually_overridden: false,
      created_at: new Date('2026-11-25T10:02:00.000Z'),
    },
  ];

  const openPrs: OpenPR[] = [
    {
      repo: 'telegraphic-dev/jean-ci',
      number: 171,
      title: 'fix: safely project encoded catalog data',
      author: 'alice',
      headSha: 'ad8ac61',
      url: 'https://github.com/telegraphic-dev/jean-ci/pull/171',
      checkStatus: 'failure',
      updatedAt: '2026-11-25T10:02:00.000Z',
      latestReviewId: 42,
      latestReviewIsCurrent: true,
    },
    {
      repo: 'telegraphic-dev/jean-ci',
      number: 172,
      title: 'feat: stale review pr',
      author: 'bob',
      headSha: 'deadbee',
      url: 'https://github.com/telegraphic-dev/jean-ci/pull/172',
      checkStatus: 'pending',
      updatedAt: '2026-11-25T09:00:00.000Z',
      latestReviewId: null,
      latestReviewIsCurrent: false,
    },
  ];

  const triggeredRuns: Array<{
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    checkNames?: string[];
    checkIdentities?: string[];
  }> = [];

  let prState = 'open';
  let prHeadSha = 'ad8ac61000000000000000000000000000000000';
  let holdReviewRelease: (() => void) | null = null;
  let holdReview = false;

  const deps: JeanCiMcpDeps = {
    baseUrl: 'https://jean-ci.example.com',
    taskStore,
    taskAbortRegistry,
    getRepo: async (fullName) => repos.find((r) => r.full_name === fullName) || null,
    getReposWithActivity: async () =>
      repos.map((r) => ({
        ...r,
        last_activity: new Date('2026-11-25T10:00:00.000Z').toISOString(),
      })),
    getOpenPRsFromEvents: async () => openPrs,
    getCheckRunsFiltered: async (opts) => {
      const items = checks.filter((c) => {
        if (opts.repo && c.repo !== opts.repo) return false;
        if (opts.prNumber !== undefined && c.pr_number !== opts.prNumber) return false;
        if (opts.status && c.status !== opts.status) return false;
        if (opts.conclusion && c.conclusion !== opts.conclusion) return false;
        if (opts.checkName && c.check_name.toLowerCase() !== opts.checkName.toLowerCase()) return false;
        if (opts.headSha && !(c.head_sha || '').startsWith(opts.headSha)) return false;
        return true;
      }) as CheckRunSummaryRecord[];
      return { items, total: items.length, page: opts.page ?? 1, limit: opts.limit ?? 25, totalPages: 1 };
    },
    getCheckRunsForPR: async (repo, prNumber, headSha) =>
      checks.filter(
        (c) =>
          c.repo === repo &&
          c.pr_number === prNumber &&
          (!headSha || (c.head_sha || '').startsWith(headSha)),
      ) as CheckRunSummaryRecord[],
    getCheckRun: async (id) => checks.find((c) => c.id === id) || null,
    getCheckApprovalSummary: async (checkId) =>
      checkId === 43
        ? { waitingForApproval: true, pendingCount: 1, hasDenied: false, segmentCount: 1 }
        : { waitingForApproval: false, pendingCount: 0, hasDenied: false, segmentCount: 1 },
    getPRReviewState: async (repo, prNumber) => ({
      repo,
      pr_number: prNumber,
      last_reviewed_sha: 'ad8ac61000000000000000000000000000000000',
      is_draft: false,
      draft_reviewed: false,
      updated_at: new Date('2026-11-25T10:00:00.000Z'),
    }),
    upsertPRReviewState: async () => {},
    overrideCheckRunToPass: async (id, reason, actor) => {
      const target = checks.find((c) => c.id === id);
      if (!target || target.manually_overridden || target.status !== 'completed' || target.conclusion !== 'failure') {
        return null;
      }
      target.manually_overridden = true;
      target.override_reason = reason;
      target.overridden_by = actor;
      target.overridden_at = new Date('2026-11-25T11:00:00.000Z');
      return target;
    },
    getOpenPRsCount: async () => openPrs.length,
    getPendingDeploymentsCount: async () => 1,
    getTaskStats: async () => ({ total_tasks: 2, total_runs: 10, runs_24h: 4, failures_24h: 1 }),
    getTaskSummary: async () => [
      {
        task_name: 'nightly-backup',
        app_uuid: 'app-1',
        app_name: 'jean-ci',
        repo: 'telegraphic-dev/jean-ci',
        total_runs: 5,
        success_count: 4,
        failure_count: 1,
        last_run: new Date('2026-11-25T08:00:00.000Z'),
        last_status: 'success',
        last_output: 'SECRET_LOG_SHOULD_BE_REDACTED',
        url: 'https://coolify.example.com/task/1',
      },
    ],
    getTaskEvents: async () => ({
      events: [
        {
          id: 1,
          task_name: 'nightly-backup',
          status: 'success',
          output: 'SECRET_EVENT_OUTPUT',
        },
      ],
      total: 1,
    }),
    getCheckRunsByRepoCount: async () => 12,
    getDeploymentsByRepoCount: async () => 5,
    getEventsByRepoCount: async () => 40,
    getDeploymentPipelines: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getDeploymentPipelinesByRepo: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getDeploymentsByRepoPaginated: async () => ({ items: [], total: 0, page: 1, limit: 25, totalPages: 0 }),
    getRecentEventsPaginated: async () => ({ items: [], total: 0, page: 1, limit: 25, totalPages: 0 }),
    getDefaultUserPrompt: async () => '## Review Criteria\nDefault prompt.',
    getPRInfo: async (_inst, owner, repo, prNumber) => ({
      number: prNumber,
      state: prState,
      title: 'fix: safely project encoded catalog data',
      draft: false,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      head: { sha: prHeadSha, ref: 'fix/catalog' },
      base: { sha: '0000000000000000000000000000000000000001', ref: 'main' },
    }),
    getRepoDefaultBranch: async () => 'main',
    fetchPRCheckFiles: async () => [
      {
        name: 'security',
        path: '.jean-ci/pr-checks/security.md',
        content:
          '# Security Review\n\n## Purpose\nCatch security bugs.\n\n## Review Instructions\nCheck auth and SQL.\n\n## Verdict Criteria\n- **PASS** if safe\n- **FAIL** if vulnerable',
      },
      {
        name: 'broken',
        path: '.jean-ci/pr-checks/broken.md',
        content: 'Just a note without sections',
      },
    ],
    runPRReview: async (installationId, owner, repo, prNumber, headSha, options) => {
      triggeredRuns.push({
        installationId,
        owner,
        repo,
        prNumber,
        headSha,
        checkNames: options?.checkNames,
        checkIdentities: options?.checkIdentities,
      });
      const names = options?.checkNames && options.checkNames.length > 0 ? options.checkNames : ['Code Review', 'security'];
      let nextDbId = 500;
      for (const checkName of names) {
        await options?.onCheckCreated?.({ dbId: nextDbId, checkName, githubCheckId: 9900 + nextDbId });
        nextDbId += 1;
      }
      if (holdReview) {
        await new Promise<void>((resolve) => {
          holdReviewRelease = resolve;
        });
      }
      let doneId = 500;
      for (const checkName of names) {
        await options?.onCheckCompleted?.({
          dbId: doneId,
          checkName,
          conclusion: 'success',
          title: '✅ All checks passed',
        });
        doneId += 1;
      }
    },
    runLocalReview: async (input) => ({
      repo: input.repo,
      checks: [
        {
          name: 'Code Review',
          verdict: 'PASS',
          title: '✅ Approved',
          summary: 'No blocking issues found.',
          normalized: '**VERDICT: PASS**\n\nNo blocking issues found.',
          isGlobal: true,
        },
      ],
      validationFailures: [],
      executionFailures: [],
    }),
  };

  return {
    deps,
    triggeredRuns,
    setPrState: (state: string) => {
      prState = state;
    },
    setPrHeadSha: (sha: string) => {
      prHeadSha = sha;
    },
    setHoldReview: (hold: boolean) => {
      holdReview = hold;
    },
    releaseHoldReview: () => {
      holdReviewRelease?.();
      holdReviewRelease = null;
    },
  };
}

function makeAuthInfo(clientId = 'api-token:db:7'): AuthInfo {
  return {
    token: 'redacted',
    clientId,
    scopes: ['mcp'],
    extra: { source: 'db', tokenId: 7, actor: clientId },
  };
}

async function callModernMcp(
  handler: ReturnType<typeof createJeanCiMcpHandler>,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    clientCapabilities?: Record<string, unknown>;
    mcpName?: string;
    authInfo?: AuthInfo;
  } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (options.mcpName) {
    headers['Mcp-Name'] = options.mcpName;
  }

  const res = await handler.fetch(
    new Request('https://jean-ci.example.com/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': options.clientCapabilities ?? {},
            'io.modelcontextprotocol/clientInfo': { name: 'jean-ci-test-client', version: '1.0.0' },
          },
        },
      }),
    }),
    { authInfo: options.authInfo ?? makeAuthInfo() },
  );

  const json = await res.json();
  return { status: res.status, json };
}

test('MCP 2026-07-28 server/discover advertises latest protocol, cache hints, and official extensions', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const { status, json } = await callModernMcp(handler, 'server/discover');
  assert.equal(status, 200);
  assert.equal(json.result.resultType, 'complete');
  assert.ok(json.result.supportedVersions.includes('2026-07-28'));
  assert.equal(json.result._meta['io.modelcontextprotocol/serverInfo'].name, MCP_SERVER_NAME);
  assert.equal(json.result._meta['io.modelcontextprotocol/serverInfo'].version, MCP_SERVER_VERSION);
  assert.equal(json.result.cacheScope, 'public');
  assert.ok(json.result.ttlMs > 0);

  const extensions = json.result.capabilities.extensions;
  assert.ok(extensions['io.modelcontextprotocol/ui'], 'MCP Apps extension advertised');
  assert.ok(extensions['io.modelcontextprotocol/tasks'], 'MCP Tasks extension advertised');
  assert.ok(extensions['io.modelcontextprotocol/skills'], 'Skills over MCP extension advertised');
  assert.ok(extensions['io.modelcontextprotocol/events'], 'MCP Events extension advertised');
});

test('MCP legacy 2025-11-25 initialize handshake works via stateless fallback', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const res = await handler.fetch(
    new Request('https://jean-ci.example.com/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1.0.0' },
        },
      }),
    }),
    { authInfo: makeAuthInfo() },
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"protocolVersion":"2025-11-25"/);
  assert.match(text, /"dev\.telegraphic\/jean-ci"/);
});

test('tools/list returns deterministic tool order and MCP Apps UI metadata', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const { status, json } = await callModernMcp(handler, 'tools/list');
  assert.equal(status, 200);
  const tools = json.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...names].sort(), 'tools must be listed in deterministic alphabetical order');
  assert.equal(names.length, 15);

  const getPrReviews = tools.find((t) => t.name === 'get_pr_reviews');
  const getReviewCheck = tools.find((t) => t.name === 'get_review_check');
  assert.equal((getPrReviews?._meta?.ui as { resourceUri?: string })?.resourceUri, REVIEW_INSPECTOR_URI);
  assert.equal((getReviewCheck?._meta?.ui as { resourceUri?: string })?.resourceUri, REVIEW_INSPECTOR_URI);

  // Read the MCP Apps UI resource and verify MIME type & postMessage handshake
  const uiRead = await callModernMcp(
    handler,
    'resources/read',
    { uri: REVIEW_INSPECTOR_URI },
    { mcpName: REVIEW_INSPECTOR_URI },
  );
  assert.equal(uiRead.status, 200);
  const uiContent = uiRead.json.result.contents[0];
  assert.equal(uiContent.mimeType, RESOURCE_MIME_TYPE);
  assert.match(uiContent.text, /ui\/initialize/);
  assert.match(uiContent.text, /ui\/notifications\/tool-result/);
  assert.match(uiContent.text, /retrigger_pr_review/);
  assert.match(uiContent.text, /checkId:\s*c\.id,\s*onlyThisCheck:\s*true/);
});

test('inspecting open PRs, PR reviews, check details, and check definitions works accurately', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  // list_open_prs with staleOnly filter
  const openRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'list_open_prs', arguments: { staleOnly: true } },
    { mcpName: 'list_open_prs' },
  );
  assert.equal(openRes.status, 200);
  assert.equal(openRes.json.result.structuredContent.total, 1);
  assert.equal(openRes.json.result.structuredContent.items[0].number, 172);

  // get_pr_reviews
  const prRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'get_pr_reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'get_pr_reviews' },
  );
  assert.equal(prRes.status, 200);
  const prData = prRes.json.result.structuredContent;
  assert.equal(prData.overallStatus, 'in_progress');
  assert.equal(prData.latestChecks.length, 2);

  // get_review_check on approval-waiting check #43 (safe status only, no command leakage)
  const checkRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'get_review_check', arguments: { checkId: 43, includeDiff: true } },
    { mcpName: 'get_review_check' },
  );
  assert.equal(checkRes.status, 200);
  const checkData = checkRes.json.result.structuredContent;
  assert.equal(checkData.approvalStatus.waitingForApproval, true);
  assert.equal(checkData.approvalStatus.pendingCount, 1);
  assert.equal(checkData.approvalStatus.approvalPageUrl, 'https://jean-ci.example.com/checks/43');
  assert.equal(checkData.check.diffPreview, 'diff --git a/lib/foo.ts b/lib/foo.ts\n+const x = 1;');

  // list_pr_check_definitions validates custom prompts
  const defRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'list_pr_check_definitions', arguments: { repo: 'telegraphic-dev/jean-ci' } },
    { mcpName: 'list_pr_check_definitions' },
  );
  assert.equal(defRes.status, 200);
  const defs = defRes.json.result.structuredContent.checks as Array<{ name: string; valid: boolean; validationErrors: string[] }>;
  assert.equal(defs.find((d) => d.name === 'Code Review')?.valid, true);
  assert.equal(defs.find((d) => d.name === 'security')?.valid, true);
  assert.equal(defs.find((d) => d.name === 'broken')?.valid, false);
  assert.ok((defs.find((d) => d.name === 'broken')?.validationErrors.length ?? 0) > 0);
});

test('retrigger_pr_review enforces guardrails and supports synchronous fallback + MCP Tasks lifecycle', async () => {
  const fixture = createFixtureDeps();
  const handler = createJeanCiMcpHandler(fixture.deps);

  // Guardrail 1: disabled repo rejected
  const disabledRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/disabled-repo', prNumber: 5 } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(disabledRes.json.result.isError, true);
  assert.match(disabledRes.json.result.content[0].text, /disabled/i);

  // Guardrail 2: head SHA mismatch rejected
  const mismatchRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'retrigger_pr_review',
      arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171, expectedHeadSha: '1111111111' },
    },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(mismatchRes.json.result.isError, true);
  assert.match(mismatchRes.json.result.content[0].text, /mismatch/i);

  // Guardrail 3: closed PR rejected
  fixture.setPrState('closed');
  const closedRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(closedRes.json.result.isError, true);
  assert.match(closedRes.json.result.content[0].text, /not open/i);
  fixture.setPrState('open');

  // Non-tasks client: resolves checkId + onlyThisCheck and queues immediately
  const queuedRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { checkId: 43, onlyThisCheck: true } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(queuedRes.status, 200);
  assert.equal(queuedRes.json.result.isError, undefined);
  assert.equal(queuedRes.json.result.structuredContent.status, 'queued');
  assert.deepEqual(queuedRes.json.result.structuredContent.checksRequested, ['security']);
  assert.deepEqual(queuedRes.json.result.structuredContent.checkIdentitiesRequested, [
    'path:.jean-ci/pr-checks/security.md',
  ]);
  assert.equal(fixture.triggeredRuns.length, 1);
  assert.deepEqual(fixture.triggeredRuns[0].checkIdentities, ['path:.jean-ci/pr-checks/security.md']);
  assert.equal(fixture.triggeredRuns[0].checkNames, undefined);

  // Tasks-capable client: returns CreateTaskResult -> poll tasks/get until completed
  const tasksCaps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
  const taskCreateRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'retrigger_pr_review', clientCapabilities: tasksCaps },
  );
  assert.equal(taskCreateRes.status, 200);
  assert.equal(taskCreateRes.json.result.resultType, 'task');
  const taskId = taskCreateRes.json.result.taskId as string;
  assert.ok(taskId.length >= 16);

  // Wait briefly for async mock run to complete
  await new Promise((r) => setTimeout(r, 25));

  const taskGetRes = await callModernMcp(
    handler,
    'tasks/get',
    { taskId },
    { mcpName: taskId, clientCapabilities: tasksCaps },
  );
  assert.equal(taskGetRes.status, 200);
  assert.equal(taskGetRes.json.result.status, 'completed');
  assert.equal(taskGetRes.json.result.result.structuredContent.completedChecks.length, 2);

  // Cross-token isolation: a different token cannot read this task (-32602)
  const crossOwnerRes = await callModernMcp(
    handler,
    'tasks/get',
    { taskId },
    { mcpName: taskId, clientCapabilities: tasksCaps, authInfo: makeAuthInfo('api-token:db:999') },
  );
  assert.equal(crossOwnerRes.json.error.code, -32602);

  // Cooperative cancellation via tasks/cancel
  fixture.setHoldReview(true);
  const cancellableCreate = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'retrigger_pr_review', clientCapabilities: tasksCaps },
  );
  const cancelTaskId = cancellableCreate.json.result.taskId as string;
  const cancelRes = await callModernMcp(
    handler,
    'tasks/cancel',
    { taskId: cancelTaskId },
    { mcpName: cancelTaskId, clientCapabilities: tasksCaps },
  );
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.result.resultType, 'complete');

  const afterCancel = await callModernMcp(
    handler,
    'tasks/get',
    { taskId: cancelTaskId },
    { mcpName: cancelTaskId, clientCapabilities: tasksCaps },
  );
  assert.equal(afterCancel.json.result.status, 'cancelled');
  fixture.releaseHoldReview();
  fixture.setHoldReview(false);
});

test('override_pr_review uses 2026-07-28 MRTR Form Elicitation when reason is omitted', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  // Step 1: call without reason from form-elicitation-capable client -> input_required
  const elicitRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'override_pr_review', arguments: { checkId: 42 } },
    { mcpName: 'override_pr_review', clientCapabilities: { elicitation: { form: {} } } },
  );
  assert.equal(elicitRes.status, 200);
  assert.equal(elicitRes.json.result.resultType, 'input_required');
  const req = elicitRes.json.result.inputRequests.override_confirmation;
  assert.equal(req.method, 'elicitation/create');
  assert.equal(req.params.mode, 'form');

  // Step 2: decline -> no override recorded
  const declineRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'override_pr_review',
      arguments: { checkId: 42 },
      inputResponses: { override_confirmation: { action: 'decline' } },
    },
    { mcpName: 'override_pr_review', clientCapabilities: { elicitation: { form: {} } } },
  );
  assert.equal(declineRes.json.result.isError, true);
  assert.equal((await deps.getCheckRun(42))?.manually_overridden, false);

  // Step 3: accept with reason -> records override with actor attribution & warning
  const acceptRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'override_pr_review',
      arguments: { checkId: 42 },
      inputResponses: {
        override_confirmation: {
          action: 'accept',
          content: { reason: 'False positive confirmed by reviewer', confirm: true },
        },
      },
    },
    { mcpName: 'override_pr_review', clientCapabilities: { elicitation: { form: {} } } },
  );
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.json.result.structuredContent.ok, true);
  assert.equal(acceptRes.json.result.structuredContent.check.manuallyOverridden, true);
  assert.equal(acceptRes.json.result.structuredContent.check.overriddenBy, 'api-token:db:7');
  assert.match(acceptRes.json.result.structuredContent.warning, /does not update the GitHub check run/i);
});

test('run_local_review works synchronously and via MCP Tasks, and list_tasks redacts outputs', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  // Synchronous local review
  const syncRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'run_local_review',
      arguments: {
        repo: 'telegraphic-dev/jean-ci',
        ref: 'main',
        diff: 'diff --git a/a.ts b/a.ts\n+export const ok = true;\n',
      },
    },
    { mcpName: 'run_local_review' },
  );
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.json.result.structuredContent.checks[0].verdict, 'PASS');

  // MCP Tasks local review
  const tasksCaps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
  const taskRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'run_local_review',
      arguments: {
        repo: 'telegraphic-dev/jean-ci',
        ref: 'main',
        diff: 'diff --git a/a.ts b/a.ts\n+export const ok = true;\n',
      },
    },
    { mcpName: 'run_local_review', clientCapabilities: tasksCaps },
  );
  assert.equal(taskRes.json.result.resultType, 'task');
  await new Promise((r) => setTimeout(r, 20));
  const doneTask = await callModernMcp(
    handler,
    'tasks/get',
    { taskId: taskRes.json.result.taskId },
    { mcpName: taskRes.json.result.taskId, clientCapabilities: tasksCaps },
  );
  assert.equal(doneTask.json.result.status, 'completed');
  assert.equal(doneTask.json.result.result.structuredContent.checks[0].verdict, 'PASS');

  // list_tasks redacts output fields (matching Public API security posture)
  const taskSummaryRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'list_tasks', arguments: { view: 'summary' } },
    { mcpName: 'list_tasks' },
  );
  assert.equal(taskSummaryRes.json.result.structuredContent.summary[0].last_output, null);
  assert.equal(taskSummaryRes.json.result.structuredContent.summary[0].output_redacted, true);

  const taskEventsRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'list_tasks', arguments: { view: 'events' } },
    { mcpName: 'list_tasks' },
  );
  assert.equal(taskEventsRes.json.result.structuredContent.events[0].output, null);
  assert.equal(taskEventsRes.json.result.structuredContent.events[0].output_redacted, true);
});

test('Skills over MCP extension serves verifiable skills, manifests, and directory reads', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const listRes = await callModernMcp(handler, 'skills/list');
  assert.equal(listRes.status, 200);
  const skills = listRes.json.result.skills as Array<{
    uri: string;
    frontmatter: { name: string; description: string };
    resources: Array<{ uri: string; digest: string; size: number }>;
  }>;
  assert.equal(skills.length, 2);
  const triage = skills.find((s) => s.frontmatter.name === 'triage-pr-review');
  assert.ok(triage);
  assert.equal(triage.uri, 'skill://jean-ci/triage-pr-review/SKILL.md');

  // Read SKILL.md and verify its SHA-256 digest matches the published manifest
  const readRes = await callModernMcp(
    handler,
    'resources/read',
    { uri: triage.uri },
    { mcpName: triage.uri },
  );
  assert.equal(readRes.status, 200);
  const text = readRes.json.result.contents[0].text as string;
  const manifestEntry = triage.resources.find((r) => r.uri === triage.uri);
  assert.ok(manifestEntry);
  const actualDigest = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  assert.equal(actualDigest, manifestEntry.digest);
  assert.equal(Buffer.byteLength(text, 'utf8'), manifestEntry.size);

  // Read references directory
  const dirUri = 'skill://jean-ci/triage-pr-review/references';
  const dirRes = await callModernMcp(
    handler,
    'resources/directory/read',
    { uri: dirUri },
    { mcpName: dirUri },
  );
  assert.equal(dirRes.status, 200);
  assert.ok(dirRes.json.result.resources.some((r: { name: string }) => r.name === 'verdict-guide.md'));
});

test('MCP resources, prompts, and completions work end-to-end', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const checkUri = 'jean-ci://checks/42';
  const checkRes = await callModernMcp(handler, 'resources/read', { uri: checkUri }, { mcpName: checkUri });
  assert.equal(checkRes.status, 200);
  const parsed = JSON.parse(checkRes.json.result.contents[0].text);
  assert.equal(parsed.check.id, 42);

  // Unknown check resource returns -32602 per 2026-07-28 spec (SEP-2164)
  const missingUri = 'jean-ci://checks/9999';
  const missingRes = await callModernMcp(handler, 'resources/read', { uri: missingUri }, { mcpName: missingUri });
  assert.equal(missingRes.json.error.code, -32602);

  // Prompt retrieval
  const promptRes = await callModernMcp(
    handler,
    'prompts/get',
    { name: 'triage-pr-reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: '171' } },
    { mcpName: 'triage-pr-reviews' },
  );
  assert.equal(promptRes.status, 200);
  assert.match(promptRes.json.result.messages[0].content.text, /telegraphic-dev\/jean-ci#171/);

  // Prompt argument completion
  const completeRes = await callModernMcp(handler, 'completion/complete', {
    ref: { type: 'ref/prompt', name: 'triage-pr-reviews' },
    argument: { name: 'repo', value: 'telegraphic-dev/j' },
  });
  assert.equal(completeRes.status, 200);
  assert.deepEqual(completeRes.json.result.completion.values, ['telegraphic-dev/jean-ci']);
});

test('MCP Server Card and AI Catalog conform to SEP-2127 with CORS, ETag, and 304 validation', async () => {
  const baseUrl = 'https://jean-ci.example.com';
  const card = buildMcpServerCard(baseUrl);
  assert.equal(card.name, MCP_SERVER_NAME);
  assert.equal(card.version, MCP_SERVER_VERSION);
  assert.deepEqual(card.supportedVersions, [...MCP_SUPPORTED_VERSIONS]);
  assert.equal(card.remotes[0].type, 'streamable-http');
  assert.equal(card.remotes[0].url, `${baseUrl}/mcp`);
  assert.equal(card.remotes[0].authentication.type, 'oauth2');
  assert.equal(
    card.remotes[0].authentication.protectedResourceMetadata,
    `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
  );

  const catalog = buildAiCatalog(baseUrl);
  assert.equal(catalog.specVersion, '1.0');
  assert.equal(catalog.entries[0].type, SERVER_CARD_MEDIA_TYPE);
  assert.equal(catalog.entries[0].url, `${baseUrl}/api/mcp/server-card`);

  const req = new Request(`${baseUrl}/api/mcp/server-card`, {
    headers: { Accept: SERVER_CARD_MEDIA_TYPE },
  });
  const res = buildDiscoveryJsonResponse(req, card, SERVER_CARD_MEDIA_TYPE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('content-type') || '', new RegExp(SERVER_CARD_MEDIA_TYPE.replace('+', '\\+')));
  const etag = res.headers.get('etag');
  assert.ok(etag);

  const conditionalReq = new Request(`${baseUrl}/api/mcp/server-card`, {
    headers: { Accept: SERVER_CARD_MEDIA_TYPE, 'If-None-Match': etag },
  });
  const notModified = buildDiscoveryJsonResponse(conditionalReq, card, SERVER_CARD_MEDIA_TYPE);
  assert.equal(notModified.status, 304);

  const catalogRes = buildDiscoveryJsonResponse(
    new Request(`${baseUrl}/.well-known/ai-catalog.json`),
    catalog,
    AI_CATALOG_MEDIA_TYPE,
  );
  assert.equal(catalogRes.status, 200);
  assert.match(catalogRes.headers.get('content-type') || '', /application\/ai-catalog\+json/);
});

test('official @modelcontextprotocol/client connects over Streamable HTTP and executes PR review tools', async () => {
  const { createServer } = await import('node:http');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler(deps);

  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else if (v !== undefined) {
        headers.set(k, v);
      }
    }
    const webReq = new Request(`http://127.0.0.1${req.url || '/api/mcp'}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });

    if (headers.get('authorization') !== 'Bearer test-secret-token') {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="jean-ci-mcp"',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const webRes = await handler.fetch(webReq, { authInfo: makeAuthInfo('api-token:env') });
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const bodyBuf = Buffer.from(await webRes.arrayBuffer());
    res.end(bodyBuf);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/api/mcp`);

  try {
    // 1. Unauthenticated request is rejected with 401 + Bearer challenge
    const unauthRes = await fetch(endpoint, { method: 'POST' });
    assert.equal(unauthRes.status, 401);
    assert.match(unauthRes.headers.get('www-authenticate') || '', /Bearer realm="jean-ci-mcp"/);

    // 2. Authenticated official MCP v2 Client connects cleanly over Streamable HTTP
    const client = new Client({ name: 'official-client-e2e', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          Authorization: 'Bearer test-secret-token',
        },
      },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 15);

      const statsResult = await client.callTool({ name: 'get_ci_stats', arguments: {} });
      assert.equal(statsResult.isError, undefined);
      assert.equal((statsResult.structuredContent as { status?: string })?.status, 'ok');

      const prResult = await client.callTool({
        name: 'get_pr_reviews',
        arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 },
      });
      assert.equal((prResult.structuredContent as { totalRuns?: number })?.totalRuns, 2);
    } finally {
      await client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
  }
});

test('get_pr_reviews groups by stable checkIdentity and excludes removed historical checks from current rollup', async () => {
  const { deps } = createFixtureDeps();
  const currentSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const olderSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const customDeps: JeanCiMcpDeps = {
    ...deps,
    getPRReviewState: async (repo, prNumber) => ({
      repo,
      pr_number: prNumber,
      last_reviewed_sha: currentSha,
      is_draft: false,
      draft_reviewed: false,
      updated_at: new Date('2026-11-26T00:00:00.000Z'),
    }),
    getCheckRunsForPR: async () => [
      // Custom check with the SAME display name "Code Review" passes at current head
      {
        id: 201,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'Code Review',
        check_identity: 'path:.jean-ci/pr-checks/Code Review.md',
        head_sha: currentSha,
        status: 'completed',
        conclusion: 'success',
        title: '✅ Custom Code Review passed',
        created_at: new Date('2026-11-26T00:02:00.000Z'),
        completed_at: new Date('2026-11-26T00:02:30.000Z'),
      },
      // Global "Code Review" failed at current head — must NOT be masked by custom check
      {
        id: 200,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'Code Review',
        check_identity: 'global:code-review',
        head_sha: currentSha,
        status: 'completed',
        conclusion: 'failure',
        title: '❌ Blocking issue',
        created_at: new Date('2026-11-26T00:01:00.000Z'),
        completed_at: new Date('2026-11-26T00:01:30.000Z'),
      },
      // Historical check removed in current commit — must stay in allChecks but NOT taint latestChecks/rollup
      {
        id: 199,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'removed-check',
        check_identity: 'path:.jean-ci/pr-checks/removed-check.md',
        head_sha: olderSha,
        status: 'completed',
        conclusion: 'success',
        title: '✅ Old check',
        created_at: new Date('2026-11-25T23:00:00.000Z'),
        completed_at: new Date('2026-11-25T23:01:00.000Z'),
      },
    ],
  };

  const handler = createJeanCiMcpHandler(customDeps);
  const res = await callModernMcp(
    handler,
    'tools/call',
    { name: 'get_pr_reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 200 } },
    { mcpName: 'get_pr_reviews' },
  );
  assert.equal(res.status, 200);
  const data = res.json.result.structuredContent;
  assert.equal(data.allChecks.length, 3, 'allChecks preserves historical runs');
  assert.equal(data.latestChecks.length, 2, 'latestChecks excludes removed check from older commit and keeps both Code Review identities');
  assert.deepEqual(
    data.latestChecks.map((c: { checkIdentity: string }) => c.checkIdentity).sort(),
    ['global:code-review', 'path:.jean-ci/pr-checks/Code Review.md'],
  );
  assert.equal(data.overallStatus, 'failing', 'failing global Code Review is not hidden by passing custom Code Review and not falsely marked stale');

  // Now verify that when all checks defined at currentSha pass (removed-check is gone), overallStatus is "passing"
  const passingDeps: JeanCiMcpDeps = {
    ...customDeps,
    fetchPRCheckFiles: async () => [],
    getCheckRunsForPR: async () => [
      {
        id: 202,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'Code Review',
        check_identity: 'global:code-review',
        head_sha: currentSha,
        status: 'completed',
        conclusion: 'success',
        title: '✅ Approved',
        created_at: new Date('2026-11-26T00:03:00.000Z'),
        completed_at: new Date('2026-11-26T00:03:30.000Z'),
      },
      {
        id: 199,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'removed-check',
        check_identity: 'path:.jean-ci/pr-checks/removed-check.md',
        head_sha: olderSha,
        status: 'completed',
        conclusion: 'success',
        title: '✅ Old check',
        created_at: new Date('2026-11-25T23:00:00.000Z'),
        completed_at: new Date('2026-11-25T23:01:00.000Z'),
      },
    ],
  };
  const passingHandler = createJeanCiMcpHandler(passingDeps);
  const passRes = await callModernMcp(
    passingHandler,
    'tools/call',
    { name: 'get_pr_reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 200 } },
    { mcpName: 'get_pr_reviews' },
  );
  assert.equal(passRes.json.result.structuredContent.overallStatus, 'passing');
  assert.equal(passRes.json.result.structuredContent.missingChecks.length, 0);
  assert.equal(passRes.json.result.structuredContent.latestChecks.length, 1);
  assert.equal(passRes.json.result.structuredContent.allChecks.length, 2);

  // Verify partial subset retrigger (only "security" ran at currentSha; global Code Review missing) NEVER reports "passing"
  const subsetDeps: JeanCiMcpDeps = {
    ...customDeps,
    fetchPRCheckFiles: async () => [
      {
        name: 'security',
        path: '.jean-ci/pr-checks/security.md',
        content: '# Security\n## Purpose\nSec\n## Review Instructions\nCheck.\n## Verdict Criteria\nPASS/FAIL',
      },
    ],
    getCheckRunsForPR: async () => [
      {
        id: 205,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'security',
        check_identity: 'path:.jean-ci/pr-checks/security.md',
        head_sha: currentSha,
        status: 'completed',
        conclusion: 'success',
        title: '✅ Security passed',
        created_at: new Date('2026-11-26T00:04:00.000Z'),
        completed_at: new Date('2026-11-26T00:04:10.000Z'),
      },
      {
        id: 198,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 200,
        check_name: 'Code Review',
        check_identity: 'global:code-review',
        head_sha: olderSha,
        status: 'completed',
        conclusion: 'failure',
        title: '❌ Failed on older head',
        created_at: new Date('2026-11-25T23:00:00.000Z'),
        completed_at: new Date('2026-11-25T23:01:00.000Z'),
      },
    ],
  };
  const subsetHandler = createJeanCiMcpHandler(subsetDeps);
  const subsetRes = await callModernMcp(
    subsetHandler,
    'tools/call',
    { name: 'get_pr_reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 200 } },
    { mcpName: 'get_pr_reviews' },
  );
  assert.equal(subsetRes.json.result.structuredContent.overallStatus, 'pending');
  assert.deepEqual(
    subsetRes.json.result.structuredContent.missingChecks.map((m: { identity: string }) => m.identity),
    ['global:code-review'],
  );
});

test('list_deployments redacts raw webhook payloads and scheduled task outputs', async () => {
  const { deps } = createFixtureDeps();
  const handler = createJeanCiMcpHandler({
    ...deps,
    getDeploymentsByRepoPaginated: async () => ({
      items: [
        {
          id: 901,
          event_type: 'coolify_task_failed',
          delivery_id: 'deliv-1',
          repo: 'telegraphic-dev/jean-ci',
          action: 'failed',
          source: 'coolify',
          processed: true,
          created_at: new Date('2026-11-26T00:05:00.000Z'),
          payload: {
            task_name: 'nightly-backup',
            application_uuid: 'app-uuid-1',
            application_name: 'jean-ci',
            output: 'SUPER_SECRET_TASK_LOG_TOKEN_XYZ',
            url: 'https://coolify.example.com/task/901',
          },
        },
        {
          id: 902,
          event_type: 'coolify_deployment_success',
          delivery_id: 'deliv-2',
          repo: 'telegraphic-dev/jean-ci',
          action: 'success',
          source: 'coolify',
          processed: true,
          created_at: new Date('2026-11-26T00:06:00.000Z'),
          payload: {
            application_uuid: 'app-uuid-1',
            application_name: 'jean-ci',
            deployment_uuid: 'dep-uuid-902',
            status: 'finished',
            secret_env: 'SHOULD_NOT_APPEAR',
            url: 'https://coolify.example.com/deploy/902',
          },
        },
      ],
      total: 2,
      page: 1,
      limit: 25,
      totalPages: 1,
    }),
  });

  const res = await callModernMcp(
    handler,
    'tools/call',
    { name: 'list_deployments', arguments: { repo: 'telegraphic-dev/jean-ci' } },
    { mcpName: 'list_deployments' },
  );
  assert.equal(res.status, 200);
  const rawSerialized = JSON.stringify(res.json.result);
  assert.ok(!rawSerialized.includes('SUPER_SECRET_TASK_LOG_TOKEN_XYZ'), 'scheduled task output must never leak through list_deployments');
  assert.ok(!rawSerialized.includes('SHOULD_NOT_APPEAR'), 'raw deployment payload must never leak through list_deployments');
  assert.equal(res.json.result.structuredContent.items[0].payload, undefined);
  assert.equal(res.json.result.structuredContent.items[0].payloadRedacted, true);
  assert.equal(res.json.result.structuredContent.items[0].taskName, 'nightly-backup');
  assert.equal(res.json.result.structuredContent.items[1].deploymentUuid, 'dep-uuid-902');
});

test('distinct PUBLIC_API_TOKENS produce distinct non-secret token fingerprints for MCP task isolation', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';

    mock.module('./lib/db.ts', {
      namedExports: {
        getActiveApiTokenByHash: async () => null,
        touchApiTokenLastUsed: async () => {},
      },
    });

    process.env.PUBLIC_API_TOKENS = 'jci_env_token_alpha_12345,jci_env_token_beta_67890';
    const { requirePublicApiToken } = await import('./lib/public-api.ts');
    const authA = await requirePublicApiToken({ headers: new Headers({ authorization: 'Bearer jci_env_token_alpha_12345' }) });
    const authB = await requirePublicApiToken({ headers: new Headers({ authorization: 'Bearer jci_env_token_beta_67890' }) });
    assert.equal(authA.authorized, true);
    assert.equal(authB.authorized, true);
    assert.equal(authA.source, 'env');
    assert.equal(authB.source, 'env');
    assert.notEqual(authA.tokenFingerprint, authB.tokenFingerprint);
    assert.equal(authA.tokenFingerprint.length, 16);
    assert.ok(!authA.tokenFingerprint.includes('jci_env_token_alpha'));
    assert.ok(!authB.tokenFingerprint.includes('jci_env_token_beta'));
  `;

  execFileSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--loader', './tests/support/tsx-loader.mjs', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});

test('MCP task persistence failures never escape as unhandled rejections', async () => {
  const { deps } = createFixtureDeps();
  const failingTaskStore = {
    create: deps.taskStore.create.bind(deps.taskStore),
    get: deps.taskStore.get.bind(deps.taskStore),
    update: async () => {
      throw new Error('simulated PostgreSQL outage during task update');
    },
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const handler = createJeanCiMcpHandler({
      ...deps,
      taskStore: failingTaskStore,
      runPRReview: async () => {
        throw new Error('simulated review failure');
      },
      runLocalReview: async () => {
        throw new Error('simulated local review failure');
      },
    });
    const tasksCaps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

    const r1 = await callModernMcp(
      handler,
      'tools/call',
      { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
      { mcpName: 'retrigger_pr_review', clientCapabilities: tasksCaps },
    );
    assert.equal(r1.json.result.resultType, 'task');

    const r2 = await callModernMcp(
      handler,
      'tools/call',
      {
        name: 'run_local_review',
        arguments: { repo: 'telegraphic-dev/jean-ci', ref: 'main', diff: 'diff --git a/a.ts b/a.ts\n+1\n' },
      },
      { mcpName: 'run_local_review', clientCapabilities: tasksCaps },
    );
    assert.equal(r2.json.result.resultType, 'task');

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(unhandled.length, 0, 'no unhandled rejections should escape when task persistence fails');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('tasks/cancel propagates AbortSignal and stops in-flight PR and local reviews cooperatively', async () => {
  const { deps } = createFixtureDeps();
  const tasksCaps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

  let prSignalAborted = false;
  let releasePr!: () => void;
  const prWaiter = new Promise<void>((resolve) => {
    releasePr = resolve;
  });

  const handler = createJeanCiMcpHandler({
    ...deps,
    runPRReview: async (_inst, _owner, _repo, _pr, _sha, options) => {
      options?.signal?.addEventListener('abort', () => {
        prSignalAborted = true;
        releasePr();
      });
      await prWaiter;
    },
  });

  const created = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'retrigger_pr_review', clientCapabilities: tasksCaps },
  );
  const taskId = created.json.result.taskId as string;
  assert.equal(prSignalAborted, false);

  const cancelRes = await callModernMcp(
    handler,
    'tasks/cancel',
    { taskId },
    { mcpName: taskId, clientCapabilities: tasksCaps },
  );
  assert.equal(cancelRes.status, 200);
  assert.equal(prSignalAborted, true, 'tasks/cancel must abort the running PR review signal');

  // Verify runLocalReview itself stops between checks when its AbortSignal fires
  const { runLocalReview } = await import('../lib/local-review.ts');
  const controller = new AbortController();
  const reviewerCalls: string[] = [];
  const localResult = await runLocalReview({
    repo: 'telegraphic-dev/jean-ci',
    ref: 'main',
    diff: 'diff --git a/a.ts b/a.ts\n+export const x = 1;\n',
    signal: controller.signal,
    __deps: {
      getUserPrompt: async () => 'Review code.',
      fetchChecksFromGit: async () => [
        {
          name: 'second-check',
          prompt: '# Second\n## Purpose\nTest\n## Review Instructions\nCheck.\n## Verdict Criteria\n- PASS\n- FAIL',
        },
      ],
      callReviewer: async (_prompt, _context, metadata) => {
        reviewerCalls.push(String(metadata?.promptName || 'unknown'));
        controller.abort();
        return { success: true, response: '**VERDICT: PASS**\n\nNo blocking issues.' };
      },
    },
  });
  assert.equal(reviewerCalls.length, 1, 'second check must not invoke reviewer after cancellation');
  assert.equal(localResult.checks.length, 0, 'cancelled check result is not finalized');
});

test('runPRReview isolates onCheckCreated/onCheckCompleted errors so completed verdicts are never overwritten', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';

    const persistedUpdates = [];
    const githubUpdates = [];

    mock.module('./lib/db.ts', {
      namedExports: {
        DEFAULT_USER_PROMPT: 'Review prompt',
        getRepo: async () => ({ id: 1, full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Review prompt',
        insertCheckRun: async () => 777,
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async (id, data) => { persistedUpdates.push({ id, ...data }); },
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        fetchPRCheckFiles: async () => [],
        getPRInfo: async () => ({ number: 1, state: 'open', title: 'Test PR', body: '', head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, base: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }),
        getPRDiff: async () => 'diff --git a/a.ts b/a.ts\\n+export const ok = true;\\n',
        createCheck: async () => ({ id: 888 }),
        updateCheck: async (_ok, _o, _r, id, data) => { githubUpdates.push({ id, ...data }); },
        createPRReview: async () => {},
      },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async () => ({ success: true, response: '**VERDICT: PASS**\\n\\nNo blocking issues found.\\n- Review profile: diff=reviewed; repository=not needed; tests=not needed.' }),
      },
    });

    const { runPRReview } = await import('./lib/pr-review.ts');
    await runPRReview(1, 'acme', 'app', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined, {
      onCheckCreated: async () => { throw new Error('simulated task store down on create'); },
      onCheckCompleted: async () => { throw new Error('simulated task store down on complete'); },
    });

    const terminalPersists = persistedUpdates.filter((u) => u.status === 'completed');
    assert.equal(terminalPersists.length, 1, 'completed check must only be persisted once');
    assert.equal(terminalPersists[0].conclusion, 'success', 'PASS verdict must not be overwritten by callback failure');
    const terminalGithub = githubUpdates.filter((u) => u.status === 'completed');
    assert.equal(terminalGithub.length, 1, 'GitHub check must only be completed once');
    assert.equal(terminalGithub[0].conclusion, 'success');
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});

test('summarizeCheckApprovalRuns and get_review_check exclude completed checks, terminal segments, and expired prompts', async () => {
  const nowMs = 1_700_000_000_000;
  const futureSec = Math.floor((nowMs + 600_000) / 1000);
  const pastSec = Math.floor((nowMs - 60_000) / 1000);

  // Completed check (e.g. recovered after restart) must never report waitingForApproval
  const completedSummary = summarizeCheckApprovalRuns(
    'completed',
    [
      {
        status: 'waiting_for_approval',
        pending: [{ prompt_id: 'p1', execution_generation: 1, app_deadline_at: futureSec }],
        denied: false,
      },
    ],
    nowMs,
  );
  assert.equal(completedSummary.waitingForApproval, false);
  assert.equal(completedSummary.pendingCount, 0);
  assert.equal(completedSummary.segmentCount, 1);

  // Active check with only expired prompts or terminal segments must not report waitingForApproval
  const expiredSummary = summarizeCheckApprovalRuns(
    'in_progress',
    [
      {
        status: 'waiting_for_approval',
        pending: [{ prompt_id: 'p-expired', execution_generation: 1, app_deadline_at: pastSec }],
        denied: false,
      },
      {
        status: 'failed',
        pending: [{ prompt_id: 'p-terminal', execution_generation: 1, app_deadline_at: futureSec }],
        denied: true,
      },
    ],
    nowMs,
  );
  assert.equal(expiredSummary.waitingForApproval, false);
  assert.equal(expiredSummary.pendingCount, 0);
  assert.equal(expiredSummary.hasDenied, true);

  // Active check with unexpired prompt on active segment reports waitingForApproval
  const activeSummary = summarizeCheckApprovalRuns(
    'in_progress',
    [
      {
        status: 'waiting_for_approval',
        pending: [
          { prompt_id: 'p-expired', execution_generation: 1, app_deadline_at: pastSec },
          { prompt_id: 'p-live', execution_generation: 1, app_deadline_at: futureSec },
        ],
        denied: false,
      },
    ],
    nowMs,
  );
  assert.equal(activeSummary.waitingForApproval, true);
  assert.equal(activeSummary.pendingCount, 1);

  // get_review_check also defensively clamps completed checks to waitingForApproval=false
  const fixture = createFixtureDeps();
  const handler = createJeanCiMcpHandler({
    ...fixture.deps,
    getCheckApprovalSummary: async () => ({
      waitingForApproval: true,
      pendingCount: 2,
      hasDenied: false,
      segmentCount: 1,
    }),
  });
  const res = await callModernMcp(
    handler,
    'tools/call',
    { name: 'get_review_check', arguments: { checkId: 42 } },
    { mcpName: 'get_review_check' },
  );
  assert.equal(res.status, 200);
  assert.equal(res.json.result.structuredContent.check.status, 'completed');
  assert.equal(res.json.result.structuredContent.approvalStatus.waitingForApproval, false);
  assert.equal(res.json.result.structuredContent.approvalStatus.pendingCount, 0);
  assert.equal(res.json.result.structuredContent.approvalStatus.approvalPageUrl, null);
});

test('retrigger_pr_review validates requested check names before advancing PR review tracking state', async () => {
  const fixture = createFixtureDeps();
  let upsertCalls = 0;
  const removedCheck: CheckRun = {
    id: 99,
    github_check_id: 9999,
    repo: 'telegraphic-dev/jean-ci',
    pr_number: 171,
    check_name: 'removed-check',
    check_identity: 'path:.jean-ci/pr-checks/removed-check.md',
    head_sha: '0000000000000000000000000000000000000001',
    status: 'completed',
    conclusion: 'failure',
    title: 'Failed',
    summary: 'Old check',
    created_at: new Date('2026-11-25T09:00:00Z'),
    completed_at: new Date('2026-11-25T09:01:00Z'),
  };

  const handler = createJeanCiMcpHandler({
    ...fixture.deps,
    getCheckRun: async (id) => (id === 99 ? removedCheck : fixture.deps.getCheckRun(id)),
    getPRInfo: async (_inst, owner, repo, prNumber) => ({
      number: prNumber,
      state: 'open',
      title: 'Draft PR',
      draft: true,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      head: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ref: 'draft-branch' },
      base: { sha: '0000000000000000000000000000000000000001', ref: 'main' },
    }),
    upsertPRReviewState: async (state) => {
      upsertCalls += 1;
      await fixture.deps.upsertPRReviewState(state);
    },
  });

  // 1) Direct unknown checkNames
  const unknownRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'retrigger_pr_review',
      arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171, checkNames: ['does-not-exist'] },
    },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(unknownRes.json.result.isError, true);
  assert.match(unknownRes.json.result.content[0].text, /Unknown check name/i);
  assert.equal(upsertCalls, 0, 'rejected checkNames must not advance jean_ci_pr_review_state');
  assert.equal(fixture.triggeredRuns.length, 0);

  // 2) onlyThisCheck referencing a custom check removed from the current head
  const removedRes = await callModernMcp(
    handler,
    'tools/call',
    {
      name: 'retrigger_pr_review',
      arguments: { checkId: 99, onlyThisCheck: true },
    },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(removedRes.json.result.isError, true);
  assert.match(removedRes.json.result.content[0].text, /removed-check/i);
  assert.equal(upsertCalls, 0, 'removed check retrigger must not mark draft head as reviewed');
  assert.equal(fixture.triggeredRuns.length, 0);
});

test('strict fetchPRCheckFiles and get_pr_reviews preserve definition-fetch errors and never falsely report passing', async () => {
  // 1) Normal 404 (absent .jean-ci/pr-checks) succeeds with empty array in strict mode
  const absentOctokit = {
    request: async () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      throw err;
    },
  };
  assert.deepEqual(await fetchPRCheckFiles(absentOctokit, 'acme', 'app', 'aaaa', { strict: true }), []);

  // 2) 403 rate-limit error throws in strict mode (never silently returns [])
  const rateLimitOctokit = {
    request: async () => {
      const err = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
      throw err;
    },
  };
  await assert.rejects(
    () => fetchPRCheckFiles(rateLimitOctokit, 'acme', 'app', 'aaaa', { strict: true }),
    /rate limit/i,
  );

  // 3) 404 "No commit found" throws in strict mode
  const badRefOctokit = {
    request: async () => {
      const err = Object.assign(new Error('No commit found for the SHA deadbeef'), { status: 404 });
      throw err;
    },
  };
  await assert.rejects(
    () => fetchPRCheckFiles(badRefOctokit, 'acme', 'app', 'deadbeef', { strict: true }),
    /No commit found/i,
  );

  // 4) Per-file retrieval error throws in strict mode (never returns partial list)
  const partialOctokit = {
    request: async (_route: string, params: { path: string }) => {
      if (params.path === '.jean-ci/pr-checks') {
        return {
          data: [
            { name: 'a.md', path: '.jean-ci/pr-checks/a.md' },
            { name: 'b.md', path: '.jean-ci/pr-checks/b.md' },
          ],
        };
      }
      if (params.path.endsWith('a.md')) {
        return { data: { content: Buffer.from('# A').toString('base64') } };
      }
      throw Object.assign(new Error('Internal Server Error'), { status: 500 });
    },
  };
  await assert.rejects(
    () => fetchPRCheckFiles(partialOctokit, 'acme', 'app', 'aaaa', { strict: true }),
    /Internal Server Error/i,
  );

  // 5) get_pr_reviews must NOT report passing when check definitions fail to load (e.g. GitHub 403)
  const fixture = createFixtureDeps();
  const headSha = 'cccccccccccccccccccccccccccccccccccccccc';
  let upsertCalls = 0;
  const handler = createJeanCiMcpHandler({
    ...fixture.deps,
    getPRReviewState: async () => ({
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 171,
      last_reviewed_sha: headSha,
      is_draft: false,
      draft_reviewed: false,
      updated_at: new Date('2026-11-26T08:00:00Z'),
    }),
    getCheckRunsForPR: async () => [
      {
        id: 201,
        github_check_id: 2001,
        repo: 'telegraphic-dev/jean-ci',
        pr_number: 171,
        check_name: 'Code Review',
        check_identity: 'global:code-review',
        head_sha: headSha,
        status: 'completed',
        conclusion: 'success',
        title: 'All checks passed',
        created_at: new Date('2026-11-26T08:00:00Z'),
        completed_at: new Date('2026-11-26T08:01:00Z'),
      },
    ],
    fetchPRCheckFiles: async () => {
      throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    },
    upsertPRReviewState: async (state) => {
      upsertCalls += 1;
      await fixture.deps.upsertPRReviewState(state);
    },
  });

  const prRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'get_pr_reviews', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'get_pr_reviews' },
  );
  assert.equal(prRes.status, 200);
  assert.equal(prRes.json.result.structuredContent.expectedChecksVerified, false);
  assert.equal(
    prRes.json.result.structuredContent.overallStatus,
    'neutral',
    'unverified check coverage must not report passing',
  );
  assert.match(prRes.json.result.content[0].text, /UNVERIFIED/i);

  // 6) retrigger_pr_review returns toolError without advancing review state if definition fetch fails
  const retriggerRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171, checkNames: ['security'] } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(retriggerRes.json.result.isError, true);
  assert.match(retriggerRes.json.result.content[0].text, /Could not verify check definitions/i);
  assert.equal(upsertCalls, 0);
});

test('MCP handler rejects untrusted Origin headers with 403 and undeclared tasks operations with -32021', async () => {
  const fixture = createFixtureDeps();
  const handler = createJeanCiMcpHandler({
    ...fixture.deps,
    baseUrl: 'http://127.0.0.1:3000',
  });

  // 1) Untrusted Origin rejected with HTTP 403 (DNS-rebinding protection)
  const evilOriginReq = new Request('http://127.0.0.1:3000/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  const evilOriginRes = await handler.fetch(evilOriginReq, { authInfo: makeAuthInfo() });
  assert.equal(evilOriginRes.status, 403);

  // Malformed "null" Origin rejected with HTTP 403
  const nullOriginReq = new Request('http://127.0.0.1:3000/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'null',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  const nullOriginRes = await handler.fetch(nullOriginReq, { authInfo: makeAuthInfo() });
  assert.equal(nullOriginRes.status, 403);

  // Loopback Origin to loopback endpoint is allowed
  const localOriginReq = new Request('http://127.0.0.1:3000/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'http://localhost:6274',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  const localOriginRes = await handler.fetch(localOriginReq, { authInfo: makeAuthInfo() });
  assert.equal(localOriginRes.status, 200);

  // 2) Create a task with tasks capability declared, then verify all 4 task operations
  //    reject with HTTP 400 and JSON-RPC -32021 when tasks capability is omitted.
  const tasksCaps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
  const createRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { repo: 'telegraphic-dev/jean-ci', prNumber: 171 } },
    { mcpName: 'retrigger_pr_review', clientCapabilities: tasksCaps },
  );
  const taskId = createRes.json.result.taskId as string;
  assert.ok(taskId);

  const undeclaredGet = await callModernMcp(handler, 'tasks/get', { taskId }, { mcpName: taskId });
  assert.equal(undeclaredGet.status, 400);
  assert.equal(undeclaredGet.json.error.code, -32021);

  const undeclaredUpdate = await callModernMcp(
    handler,
    'tasks/update',
    { taskId, inputResponses: {} },
    { mcpName: taskId },
  );
  assert.equal(undeclaredUpdate.status, 400);
  assert.equal(undeclaredUpdate.json.error.code, -32021);

  const undeclaredCancel = await callModernMcp(handler, 'tasks/cancel', { taskId }, { mcpName: taskId });
  assert.equal(undeclaredCancel.status, 400);
  assert.equal(undeclaredCancel.json.error.code, -32021);

  const undeclaredSub = await callModernMcp(
    handler,
    'subscriptions/listen',
    { notifications: { taskIds: [taskId] } },
    {},
  );
  assert.equal(undeclaredSub.status, 400);
  assert.equal(undeclaredSub.json.error.code, -32021);
  assert.deepEqual(undeclaredSub.json.error.data?.requiredCapabilities, {
    extensions: { 'io.modelcontextprotocol/tasks': {} },
  });
});

test('single-check retrigger preserves check_identity and rejects ambiguous legacy names', async () => {
  const fixture = createFixtureDeps();
  const customIdentity = 'path:.jean-ci/pr-checks/Code Review.md';
  let upsertCalls = 0;

  const customCodeReviewCheck: CheckRun = {
    id: 301,
    github_check_id: 3001,
    repo: 'telegraphic-dev/jean-ci',
    pr_number: 171,
    check_name: 'Code Review',
    check_identity: customIdentity,
    head_sha: 'ad8ac61000000000000000000000000000000000',
    status: 'completed',
    conclusion: 'failure',
    title: 'Custom failed',
    summary: 'Custom finding',
    created_at: new Date('2026-11-26T08:00:00Z'),
    completed_at: new Date('2026-11-26T08:01:00Z'),
  };
  const legacyAmbiguousCheck: CheckRun = {
    ...customCodeReviewCheck,
    id: 302,
    github_check_id: 3002,
    check_identity: undefined,
  };

  const handler = createJeanCiMcpHandler({
    ...fixture.deps,
    getCheckRun: async (id) => {
      if (id === 301) return customCodeReviewCheck;
      if (id === 302) return legacyAmbiguousCheck;
      return fixture.deps.getCheckRun(id);
    },
    fetchPRCheckFiles: async () => [
      {
        name: 'Code Review',
        path: '.jean-ci/pr-checks/Code Review.md',
        content: '# Custom Code Review\n\n## Purpose\nCustom.\n\n## Review Instructions\nCheck.\n\n## Verdict Criteria\n- **PASS** if ok\n- **FAIL** if bad',
      },
    ],
    upsertPRReviewState: async (state) => {
      upsertCalls += 1;
      await fixture.deps.upsertPRReviewState(state);
    },
  });

  // 1) Legacy check without check_identity whose name collides with global Code Review is rejected
  const ambiguousRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { checkId: 302, onlyThisCheck: true } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(ambiguousRes.json.result.isError, true);
  assert.match(ambiguousRes.json.result.content[0].text, /Ambiguous legacy check name/i);
  assert.equal(upsertCalls, 0, 'ambiguous legacy single-check retrigger must not advance review state');
  assert.equal(fixture.triggeredRuns.length, 0);

  // 2) Custom check with stable check_identity passes only its identity to runPRReview
  const customRes = await callModernMcp(
    handler,
    'tools/call',
    { name: 'retrigger_pr_review', arguments: { checkId: 301, onlyThisCheck: true } },
    { mcpName: 'retrigger_pr_review' },
  );
  assert.equal(customRes.json.result.isError, undefined);
  assert.deepEqual(customRes.json.result.structuredContent.checkIdentitiesRequested, [customIdentity]);
  assert.equal(fixture.triggeredRuns.length, 1);
  assert.deepEqual(fixture.triggeredRuns[0].checkIdentities, [customIdentity]);
  assert.equal(fixture.triggeredRuns[0].checkNames, undefined);

  // 3) Verify real runPRReview with checkIdentities runs ONLY the custom check and never submits a global PR review
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';

    const inserted = [];
    let prReviewSubmissions = 0;

    mock.module('./lib/db.ts', {
      namedExports: {
        DEFAULT_USER_PROMPT: 'Global prompt',
        getRepo: async () => ({ id: 1, full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Global prompt',
        insertCheckRun: async (row) => { inserted.push(row); return 900 + inserted.length; },
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async () => {},
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        fetchPRCheckFiles: async () => [
          {
            name: 'Code Review',
            path: '.jean-ci/pr-checks/Code Review.md',
            content: '## Purpose\\nCustom.\\n\\n## Review Instructions\\nCheck.\\n\\n## Verdict Criteria\\n- **PASS** if ok\\n- **FAIL** if bad',
          },
        ],
        getPRInfo: async () => ({ number: 1, state: 'open', title: 'Test PR', body: '', head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, base: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }),
        getPRDiff: async () => 'diff --git a/a.ts b/a.ts\\n+export const ok = true;\\n',
        createCheck: async () => ({ id: 888 }),
        updateCheck: async () => {},
        createPRReview: async () => { prReviewSubmissions += 1; },
      },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async () => ({ success: true, response: '**VERDICT: PASS**\\n\\nLooks good.\\n- Review profile: diff=reviewed; repository=not needed; tests=not needed.' }),
      },
    });

    const { runPRReview } = await import('./lib/pr-review.ts');
    await runPRReview(1, 'acme', 'app', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined, {
      checkIdentities: ['path:.jean-ci/pr-checks/Code Review.md'],
    });

    assert.equal(inserted.length, 1, 'only the single custom check must run');
    assert.equal(inserted[0].check_identity, 'path:.jean-ci/pr-checks/Code Review.md');
    assert.equal(prReviewSubmissions, 0, 'global PR review publication must not run for custom check identity');
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});

test('runPRReview preserves already-confirmed FAIL findings when cancelled between review segments', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';

    const persistedUpdates = [];
    const githubUpdates = [];
    const abortController = new AbortController();

    mock.module('./lib/db.ts', {
      namedExports: {
        DEFAULT_USER_PROMPT: 'Review prompt',
        getRepo: async () => ({ id: 1, full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Review prompt',
        insertCheckRun: async () => 950,
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async (id, data) => { persistedUpdates.push({ id, ...data }); },
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        fetchPRCheckFiles: async () => [],
        getPRInfo: async () => ({ number: 1, state: 'open', title: 'Test PR', body: '', head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, base: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }),
        getPRDiff: async () => [
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1,1 +1,2 @@',
          '+export const a = 1;',
          'diff --git a/src/b.ts b/src/b.ts',
          '--- a/src/b.ts',
          '+++ b/src/b.ts',
          '@@ -1,1 +1,2 @@',
          '+export const b = 2;',
        ].join('\\n'),
        createCheck: async () => ({ id: 888 }),
        updateCheck: async (_ok, _o, _r, id, data) => { githubUpdates.push({ id, ...data }); },
        createPRReview: async () => {},
      },
    });
    mock.module('./lib/review-context.ts', {
      namedExports: {
        buildReviewContexts: () => [
          { label: 'segment-1', context: 'ctx-1' },
          { label: 'segment-2', context: 'ctx-2' },
        ],
        truncateReviewDiff: (d) => d,
      },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async () => {
          // Cancel after segment-1 returns a confirmed FAIL finding
          abortController.abort();
          return {
            success: true,
            response: '**VERDICT: FAIL**\\n\\nBlocking SQL injection bug in src/a.ts:2.\\n- Review profile: diff=reviewed; repository=not needed; tests=not needed.',
          };
        },
      },
    });

    const { runPRReview } = await import('./lib/pr-review.ts');
    await runPRReview(1, 'acme', 'app', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined, {
      signal: abortController.signal,
    });

    const terminal = persistedUpdates.filter((u) => u.status === 'completed');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].conclusion, 'failure', 'confirmed FAIL finding must not be downgraded to neutral on cancel');
    assert.match(terminal[0].summary, /SQL injection/i);
    assert.match(terminal[0].summary, /interrupted|incomplete/i);
    const ghTerminal = githubUpdates.filter((u) => u.status === 'completed');
    assert.equal(ghTerminal.length, 1);
    assert.equal(ghTerminal[0].conclusion, 'failure');
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});







