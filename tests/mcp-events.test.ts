import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  EVENTS_EXTENSION_ID,
  EventsErrorCode,
  InMemoryMcpEventsStore,
  buildPrReviewApprovalRequiredPayload,
  buildPrReviewCheckCompletedPayload,
  buildPrReviewCompletedPayload,
  deliverWebhookPinnedHttps,
  deriveSubscriptionIdentity,
  isValidWebhookCallbackUrl,
  parseWebhookSecretBytes,
  publishMcpEvent,
  signStandardWebhook,
  type WebhookDeliverFn,
} from '../lib/mcp/events.ts';
import { createJeanCiMcpHandler } from '../lib/mcp/server.ts';
import { buildMcpServerCard } from '../lib/mcp/server-card.ts';
import { InMemoryMcpTaskStore, McpTaskAbortRegistry } from '../lib/mcp/tasks.ts';

function makeWebhookSecret(byteLen = 32): string {
  return `whsec_${randomBytes(byteLen).toString('base64')}`;
}

function makeAuthInfo(
  clientId = 'oauth:42:clienthash123456',
  scopes: string[] = ['mcp:read', 'mcp:write'],
  extra: Record<string, unknown> = { source: 'oauth', actor: 'github:musketyr', oauthFamilyId: 'fam-1' },
): AuthInfo {
  return {
    token: 'redacted',
    clientId,
    scopes,
    extra,
  };
}

function verifyStandardWebhookSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
): boolean {
  const key = parseWebhookSecretBytes(secret);
  if (!key) return false;
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'] || '';
  const expected = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64')}`;
  return sigHeader.split(' ').includes(expected);
}

async function callEventsRpc(
  handler: ReturnType<typeof createJeanCiMcpHandler>,
  method: string,
  params: Record<string, unknown> = {},
  options?: {
    authInfo?: AuthInfo;
    mcpNameHeader?: string | null;
  },
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (options?.mcpNameHeader !== null) {
    if (options?.mcpNameHeader !== undefined) {
      headers['Mcp-Name'] = options.mcpNameHeader;
    } else if (typeof params.name === 'string') {
      headers['Mcp-Name'] = params.name;
    }
  }
  const res = await handler.fetch(
    new Request('https://jean-ci.example.com/mcp', {
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
            'io.modelcontextprotocol/clientInfo': { name: 'events-test', version: '1.0' },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { [EVENTS_EXTENSION_ID]: {} },
            },
          },
        },
      }),
    }),
    { authInfo: options?.authInfo ?? makeAuthInfo() },
  );
  const json = (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: Record<string, unknown> };
  };
  return { status: res.status, json };
}

test('MCP Events discovery, events/list, mcp:read enforcement, and Mcp-Name routing validation', async () => {
  const eventsStore = new InMemoryMcpEventsStore();
  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore,
  });

  // Server Card advertises io.modelcontextprotocol/events
  const card = buildMcpServerCard('https://jean-ci.example.com');
  assert.ok(card.capabilities.extensions.includes(EVENTS_EXTENSION_ID));

  // events/list returns all 3 PR review event descriptors with poll + webhook modes
  const listRes = await callEventsRpc(handler, 'events/list', {});
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.result?.resultType, 'complete');
  const events = listRes.json.result?.events as Array<{
    name: string;
    delivery: string[];
    inputSchema: Record<string, unknown>;
    payloadSchema: Record<string, unknown>;
  }>;
  assert.deepEqual(
    events.map((e) => e.name),
    ['pr_review.completed', 'pr_review.check_completed', 'pr_review.approval_required'],
  );
  for (const ev of events) {
    assert.deepEqual(ev.delivery, ['poll', 'webhook']);
    assert.equal(ev.inputSchema.type, 'object');
    assert.equal(ev.payloadSchema.type, 'object');
  }

  // Write-only OAuth token without mcp:read gets Forbidden (-32024)
  const writeOnlyAuth = makeAuthInfo('oauth:42:writeonly', ['mcp:write']);
  const deniedList = await callEventsRpc(handler, 'events/list', {}, { authInfo: writeOnlyAuth });
  assert.equal(deniedList.json.error?.code, EventsErrorCode.Forbidden);

  // Missing Mcp-Name header on events/poll fails with HTTP 400 + HeaderMismatch (-32020)
  const missingHeader = await callEventsRpc(
    handler,
    'events/poll',
    { name: 'pr_review.completed', cursor: null },
    { mcpNameHeader: null },
  );
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error?.code, EventsErrorCode.HeaderMismatch);

  // Mismatched Mcp-Name header fails with HTTP 400 + HeaderMismatch (-32020)
  const mismatchedHeader = await callEventsRpc(
    handler,
    'events/poll',
    { name: 'pr_review.completed', cursor: null },
    { mcpNameHeader: 'pr_review.check_completed' },
  );
  assert.equal(mismatchedHeader.status, 400);
  assert.equal(mismatchedHeader.json.error?.code, EventsErrorCode.HeaderMismatch);

  // Base64 sentinel encoding for Mcp-Name succeeds
  const encodedName = `=?base64?${Buffer.from('pr_review.completed').toString('base64')}?=`;
  const base64Header = await callEventsRpc(
    handler,
    'events/poll',
    { name: 'pr_review.completed', cursor: null },
    { mcpNameHeader: encodedName },
  );
  assert.equal(base64Header.status, 200);
  assert.equal(base64Header.json.result?.resultType, 'complete');

  // events/stream returns Unsupported (-32026) with deliveryMode=push
  const streamRes = await callEventsRpc(handler, 'events/stream', {
    name: 'pr_review.completed',
    cursor: null,
  });
  assert.equal(streamRes.json.error?.code, EventsErrorCode.Unsupported);
  assert.deepEqual(streamRes.json.error?.data, { feature: 'deliveryMode', value: 'push' });
});

test('events/poll supports null bootstrap, filtering, pagination, maxAgeMs, and retention truncation', async () => {
  const eventsStore = new InMemoryMcpEventsStore();
  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore,
  });

  // Pre-existing historical event before bootstrap
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 100,
      headSha: 'a'.repeat(40),
      checks: [{ checkId: 1, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
  );

  // 1) Bootstrap with cursor: null starts from now (no historical replay)
  const initPoll = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    cursor: null,
  });
  assert.equal(initPoll.status, 200);
  assert.deepEqual(initPoll.json.result?.events, []);
  assert.equal(initPoll.json.result?.truncated, false);
  assert.equal(initPoll.json.result?.hasMore, false);
  const startCursor = String(initPoll.json.result?.cursor);
  assert.match(startCursor, /^evt_v1_\d+$/);

  // 2) Publish 3 new events (2 matching repo, 1 other repo)
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 175,
      headSha: 'b'.repeat(40),
      checks: [{ checkId: 10, checkName: 'Code Review', conclusion: 'failure' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
  );
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'other/repo',
      prNumber: 9,
      headSha: 'c'.repeat(40),
      checks: [{ checkId: 11, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
  );
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 176,
      headSha: 'd'.repeat(40),
      checks: [{ checkId: 12, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
  );

  // Paginate with maxEvents: 1 -> first event + hasMore: true
  const page1 = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    cursor: startCursor,
    maxEvents: 1,
  });
  assert.equal(page1.json.result?.hasMore, true);
  const p1Events = page1.json.result?.events as Array<{ name: string; data: Record<string, unknown>; cursor?: unknown }>;
  assert.equal(p1Events.length, 1);
  assert.equal(p1Events[0].data.prNumber, 175);
  assert.equal(p1Events[0].data.overallConclusion, 'failure');
  // Poll occurrences must NOT include per-event cursor (response-level cursor only per SEP-3415)
  assert.equal(p1Events[0].cursor, undefined);

  const page2 = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    cursor: String(page1.json.result?.cursor),
    maxEvents: 10,
  });
  assert.equal(page2.json.result?.hasMore, false);
  const p2Events = page2.json.result?.events as Array<{ data: Record<string, unknown> }>;
  assert.equal(p2Events.length, 1);
  assert.equal(p2Events[0].data.prNumber, 176);

  // Quiet poll returns empty array and advances cursor
  const quiet = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    cursor: String(page2.json.result?.cursor),
  });
  assert.deepEqual(quiet.json.result?.events, []);

  // Retention truncation: prune old events and poll with stale startCursor -> truncated: true
  eventsStore.pruneEventsBeforeId(4);
  const stale = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    cursor: startCursor,
  });
  assert.equal(stale.json.result?.truncated, true);

  // Unknown event name -> NotFound (-32023)
  const unknown = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.nonexistent',
    cursor: null,
  });
  assert.equal(unknown.json.error?.code, EventsErrorCode.NotFound);
  assert.deepEqual(unknown.json.error?.data, { kind: 'event' });

  // Invalid filter argument -> InvalidParams (-32602)
  const badArgs = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.completed',
    arguments: { repo: 'not-a-valid-slug' },
    cursor: null,
  });
  assert.equal(badArgs.json.error?.code, EventsErrorCode.InvalidParams);
});

test('events/subscribe and webhook delivery enforce verification handshake, Standard Webhooks signing, secret rotation, retries, SSRF, and revocation', async () => {
  const eventsStore = new InMemoryMcpEventsStore();
  const receivedDeliveries: Array<{
    url: string;
    headers: Record<string, string>;
    rawBody: string;
    parsed: Record<string, unknown>;
  }> = [];

  let nextDeliveryStatuses: number[] = [];
  let rejectChallenge = false;

  const mockDeliverWebhook: WebhookDeliverFn = async ({ url, rawBody, headers }) => {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    receivedDeliveries.push({ url: url.toString(), headers, rawBody, parsed });

    if (parsed.type === 'verification') {
      if (rejectChallenge) {
        return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: 'wrong-nonce' }) };
      }
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }

    const forcedStatus = nextDeliveryStatuses.shift();
    if (forcedStatus && (forcedStatus < 200 || forcedStatus >= 300)) {
      return {
        ok: false,
        status: forcedStatus,
        errorCategory: forcedStatus >= 500 ? 'http_5xx' : 'http_4xx',
      };
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };

  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore,
    deliverEventWebhook: mockDeliverWebhook,
    eventRetryDelaysMs: [0, 0],
  });

  const secret1 = makeWebhookSecret(32);
  const secret2 = makeWebhookSecret(32);
  const callbackUrl = 'https://hooks.agent.example/mcp/jean-ci';

  // Secret validation & callback URL SSRF validation
  assert.equal(parseWebhookSecretBytes('not_a_secret'), null);
  assert.equal(parseWebhookSecretBytes(`whsec_${randomBytes(16).toString('base64')}`), null); // < 24 bytes
  assert.ok(parseWebhookSecretBytes(secret1));
  assert.equal(isValidWebhookCallbackUrl('http://hooks.agent.example/cb'), null);
  assert.equal(isValidWebhookCallbackUrl('https://127.0.0.1/cb'), null);
  assert.equal(isValidWebhookCallbackUrl('https://[::ffff:127.0.0.1]/cb'), null);
  assert.equal(isValidWebhookCallbackUrl('https://169.254.169.254/latest'), null);
  assert.ok(isValidWebhookCallbackUrl(callbackUrl));

  // Pinned-DNS SSRF check blocks private IP at delivery time
  let dnsCalls = 0;
  const ssrfAttempt = await deliverWebhookPinnedHttps(
    {
      url: new URL(callbackUrl),
      rawBody: '{}',
      headers: {},
    },
    async () => {
      dnsCalls += 1;
      return [{ address: '::ffff:7f00:1', family: 6 }];
    },
  );
  assert.equal(ssrfAttempt.ok, false);
  assert.equal(ssrfAttempt.errorCategory, 'connection_refused');
  assert.equal(dnsCalls, 1);

  // Anonymous principal cannot subscribe to webhooks (-32024 Forbidden)
  const anonSub = await callEventsRpc(
    handler,
    'events/subscribe',
    {
      name: 'pr_review.completed',
      delivery: { mode: 'webhook', url: callbackUrl, secret: secret1 },
    },
    { authInfo: makeAuthInfo('anonymous') },
  );
  assert.equal(anonSub.json.error?.code, EventsErrorCode.Forbidden);

  // Failed challenge handshake returns CallbackEndpointError (-32027) with reason=challenge_failed
  rejectChallenge = true;
  const failedVerify = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { mode: 'webhook', url: callbackUrl, secret: secret1 },
  });
  assert.equal(failedVerify.json.error?.code, EventsErrorCode.CallbackEndpointError);
  assert.deepEqual(failedVerify.json.error?.data, { reason: 'challenge_failed' });
  rejectChallenge = false;

  // Successful subscribe performs signed verification handshake and returns deterministic sub_* ID
  receivedDeliveries.length = 0;
  const subRes = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { mode: 'webhook', url: callbackUrl, secret: secret1 },
    ttlMs: 30_000, // Clamped up to 60s minimum floor
  });
  assert.equal(subRes.status, 200);
  assert.equal(subRes.json.result?.resultType, 'complete');
  const expectedId = deriveSubscriptionIdentity(
    'oauth:42:clienthash123456',
    callbackUrl,
    'pr_review.completed',
    { repo: 'telegraphic-dev/jean-ci' },
  ).subscriptionId;
  assert.equal(subRes.json.result?.id, expectedId);
  assert.equal(receivedDeliveries.length, 1);
  assert.equal(receivedDeliveries[0].parsed.type, 'verification');
  assert.equal(receivedDeliveries[0].headers['X-MCP-Subscription-Id'], expectedId);
  assert.equal(verifyStandardWebhookSignature(receivedDeliveries[0].headers, receivedDeliveries[0].rawBody, secret1), true);

  // Deliver an event with transient 503 followed by 200 -> retries keep the same webhook-id
  receivedDeliveries.length = 0;
  nextDeliveryStatuses = [503, 200];
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 175,
      headSha: 'e'.repeat(40),
      checks: [{ checkId: 55, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: mockDeliverWebhook, retryDelaysMs: [0, 0], awaitDeliveries: true },
  );
  assert.equal(receivedDeliveries.length, 2);
  assert.equal(receivedDeliveries[0].headers['webhook-id'], receivedDeliveries[1].headers['webhook-id']);
  assert.equal(verifyStandardWebhookSignature(receivedDeliveries[1].headers, receivedDeliveries[1].rawBody, secret1), true);
  assert.equal(receivedDeliveries[1].parsed.name, 'pr_review.completed');
  assert.match(String(receivedDeliveries[1].parsed.cursor), /^evt_v1_\d+$/);

  // Refresh with rotated secret2 -> skips re-verification (cached), returns deliveryStatus, and dual-signs with secret1 + secret2!
  receivedDeliveries.length = 0;
  const refreshRes = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { mode: 'webhook', url: callbackUrl, secret: secret2 },
    ttlMs: null, // Server grants finite max 7-day refreshBefore
  });
  assert.equal(refreshRes.json.result?.id, expectedId);
  assert.equal(receivedDeliveries.length, 0, 'verification must be cached per (principal, url)');
  const deliveryStatus = refreshRes.json.result?.deliveryStatus as { active: boolean; lastError: string | null };
  assert.equal(deliveryStatus.active, true);
  assert.equal(deliveryStatus.lastError, null);
  assert.equal(typeof refreshRes.json.result?.refreshBefore, 'string');

  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 176,
      headSha: 'f'.repeat(40),
      checks: [{ checkId: 56, checkName: 'Code Review', conclusion: 'failure' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: mockDeliverWebhook, retryDelaysMs: [0, 0], awaitDeliveries: true },
  );
  assert.equal(receivedDeliveries.length, 1);
  assert.equal(verifyStandardWebhookSignature(receivedDeliveries[0].headers, receivedDeliveries[0].rawBody, secret2), true);
  assert.equal(verifyStandardWebhookSignature(receivedDeliveries[0].headers, receivedDeliveries[0].rawBody, secret1), true);

  // 410 Gone is treated as non-retryable without retrying or suspending
  receivedDeliveries.length = 0;
  nextDeliveryStatuses = [410];
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 177,
      headSha: '1'.repeat(40),
      checks: [{ checkId: 57, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: mockDeliverWebhook, retryDelaysMs: [0, 0], awaitDeliveries: true },
  );
  assert.equal(receivedDeliveries.length, 1);

  // Revoking OAuth family terminates the subscription on next delivery with signed terminated envelope (-32024)
  receivedDeliveries.length = 0;
  eventsStore.revokeOAuthFamily('fam-1');
  await publishMcpEvent(
    eventsStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 178,
      headSha: '2'.repeat(40),
      checks: [{ checkId: 58, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: mockDeliverWebhook, retryDelaysMs: [0, 0], awaitDeliveries: true },
  );
  assert.equal(receivedDeliveries.length, 1);
  assert.equal(receivedDeliveries[0].parsed.type, 'terminated');
  assert.equal((receivedDeliveries[0].parsed.error as { code: number }).code, EventsErrorCode.Forbidden);

  // Unsubscribing an already-removed subscription returns NotFound (-32023)
  const unsubMissing = await callEventsRpc(handler, 'events/unsubscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { url: callbackUrl },
  });
  assert.equal(unsubMissing.json.error?.code, EventsErrorCode.NotFound);
  assert.deepEqual(unsubMissing.json.error?.data, { kind: 'subscription' });
});

test('PR review event builders produce minimal safe triage payloads', () => {
  const checkEv = buildPrReviewCheckCompletedPayload({
    checkId: 42,
    repo: 'telegraphic-dev/jean-ci',
    prNumber: 175,
    headSha: 'abc1234567890',
    checkName: 'Code Review',
    checkIdentity: 'global:code-review',
    conclusion: 'failure',
    baseUrl: 'https://jean-ci.telegraphic.app/',
  });
  assert.equal(checkEv.eventId, 'jci_chk_42');
  assert.equal(checkEv.data.detailsUrl, 'https://jean-ci.telegraphic.app/checks/42');
  assert.equal(checkEv.data.prUrl, 'https://github.com/telegraphic-dev/jean-ci/pull/175');

  const prEv = buildPrReviewCompletedPayload({
    repo: 'telegraphic-dev/jean-ci',
    prNumber: 175,
    headSha: 'abc1234567890',
    checks: [
      { checkId: 42, checkName: 'Code Review', checkIdentity: 'global:code-review', conclusion: 'success' },
      { checkId: 43, checkName: 'api-openapi-parity', checkIdentity: 'path:.jean-ci/pr-checks/api-openapi-parity.md', conclusion: 'failure' },
    ],
    baseUrl: 'https://jean-ci.telegraphic.app',
  });
  assert.equal(prEv.data.overallConclusion, 'failure');
  assert.equal(prEv.data.checksCount, 2);
  assert.equal(prEv.data.failedCount, 1);

  const apprEv = buildPrReviewApprovalRequiredPayload({
    checkId: 44,
    repo: 'telegraphic-dev/jean-ci',
    prNumber: 175,
    headSha: 'abc1234567890',
    checkName: 'Code Review',
    baseUrl: 'https://jean-ci.telegraphic.app',
  });
  assert.equal(apprEv.name, 'pr_review.approval_required');
  assert.equal(apprEv.data.detailsUrl, 'https://jean-ci.telegraphic.app/checks/44');
  assert.equal('command' in apprEv.data, false);
});

test('signStandardWebhook encodes multi-secret Standard Webhooks signatures cleanly', () => {
  const s1 = makeWebhookSecret(24);
  const s2 = makeWebhookSecret(64);
  const header = signStandardWebhook('msg_test_1', 1700000000, '{"ok":true}', [s1, s2]);
  const parts = header.split(' ');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^v1,/);
  assert.match(parts[1], /^v1,/);
});

test('events/poll honors maxAgeMs truncation, events/unsubscribe removes active subscriptions, and quota enforces ResourceExhausted', async () => {
  const eventsStore = new InMemoryMcpEventsStore();
  const mockDeliverWebhook: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };

  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore,
    deliverEventWebhook: mockDeliverWebhook,
    eventRetryDelaysMs: [0],
  });

  // Insert an old event (10 minutes ago) and a recent event (now)
  const oldEv = await eventsStore.insertEvent({
    ...buildPrReviewCheckCompletedPayload({
      checkId: 201,
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      checkName: 'Code Review',
      conclusion: 'success',
      baseUrl: 'https://jean-ci.example.com',
    }),
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });
  await eventsStore.insertEvent(
    buildPrReviewCheckCompletedPayload({
      checkId: 202,
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 2,
      headSha: 'b'.repeat(40),
      checkName: 'Code Review',
      conclusion: 'failure',
      baseUrl: 'https://jean-ci.example.com',
    }),
  );

  // Polling from cursor 0 with maxAgeMs=60s skips the 10-minute-old event and sets truncated=true
  const boundedPoll = await callEventsRpc(handler, 'events/poll', {
    name: 'pr_review.check_completed',
    cursor: 'evt_v1_0',
    maxAgeMs: 60_000,
  });
  assert.equal(oldEv.id, 1);
  assert.equal(boundedPoll.json.result?.truncated, true);
  const returned = boundedPoll.json.result?.events as Array<{ eventId: string }>;
  assert.deepEqual(
    returned.map((e) => e.eventId),
    ['jci_chk_202'],
  );

  // Enforce per-principal quota (25 active subscriptions) -> 26th fails with ResourceExhausted (-32025)
  const secret = makeWebhookSecret(32);
  const callbackUrl = 'https://hooks.quota.example/mcp';
  for (let i = 1; i <= 25; i += 1) {
    const res = await callEventsRpc(handler, 'events/subscribe', {
      name: 'pr_review.completed',
      arguments: { prNumber: i },
      delivery: { mode: 'webhook', url: callbackUrl, secret },
    });
    assert.equal(res.json.error, undefined, `expected subscription #${i} to succeed`);
  }
  const overQuota = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { prNumber: 26 },
    delivery: { mode: 'webhook', url: callbackUrl, secret },
  });
  assert.equal(overQuota.json.error?.code, EventsErrorCode.ResourceExhausted);
  assert.deepEqual(overQuota.json.error?.data, { limit: 'subscriptions', max: 25 });

  // Unsubscribing #1 frees a slot so #26 now succeeds
  const unsub = await callEventsRpc(handler, 'events/unsubscribe', {
    name: 'pr_review.completed',
    arguments: { prNumber: 1 },
    delivery: { url: callbackUrl },
  });
  assert.equal(unsub.json.result?.resultType, 'complete');

  const nowAllowed = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { prNumber: 26 },
    delivery: { mode: 'webhook', url: callbackUrl, secret },
  });
  assert.equal(nowAllowed.json.error, undefined);
});

test('runPRReview emits pr_review.check_completed and pr_review.completed events into McpEventsStore', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';

    const dbExports = await import('./lib/db.ts');
    mock.module('./lib/db.ts', {
      namedExports: {
        ...dbExports,
        getRepo: async () => ({ full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Review this PR.',
        DEFAULT_USER_PROMPT: 'Review this PR.',
        insertCheckRun: async () => 501,
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async () => {},
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        getPRDiff: async () => 'diff --git a/a.ts b/a.ts\\n+export const ok = true;\\n',
        getPRInfo: async () => ({ title: 'Test PR', body: 'Body', head: { sha: '${'a'.repeat(40)}' } }),
        createCheck: async () => ({ id: 901 }),
        updateCheck: async () => {},
        createPRReview: async () => {},
        fetchPRCheckFiles: async () => [],
      },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async () => ({
          success: true,
          response: 'VERDICT: PASS\\nTITLE: Looks good\\nSUMMARY: All checks passed.',
        }),
      },
    });

    const { InMemoryMcpEventsStore } = await import('./lib/mcp/events.ts');
    const { runPRReview } = await import('./lib/pr-review.ts');
    const store = new InMemoryMcpEventsStore();
    const observed = [];
    await runPRReview(1, 'acme', 'app', 77, '${'a'.repeat(40)}', undefined, {
      mcpEventsStore: store,
      onMcpEvent: (ev) => { observed.push(ev); },
    });

    assert.deepEqual(observed.map((e) => e.name), ['pr_review.check_completed', 'pr_review.completed']);
    const checkEvents = await store.queryEvents({ name: 'pr_review.check_completed', afterId: 0, limit: 10 });
    const prEvents = await store.queryEvents({ name: 'pr_review.completed', afterId: 0, limit: 10 });
    assert.equal(checkEvents.length, 1);
    assert.equal(checkEvents[0].data.checkId, 501);
    assert.equal(checkEvents[0].data.conclusion, 'success');
    assert.equal(prEvents.length, 1);
    assert.equal(prEvents[0].data.repo, 'acme/app');
    assert.equal(prEvents[0].data.prNumber, 77);
    assert.equal(prEvents[0].data.overallConclusion, 'success');
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
    },
  );
});

test('webhook retry rechecks revocation during backoff, replay delivers newest 50 on large backlog, and suspended refresh recovers missed events', async () => {
  const { getConfiguredEnvApiTokens } = await import('../lib/mcp/events.ts');
  const singleEnvKey = ['PUBLIC', 'API', 'TOKEN'].join('_');
  const multiEnvKey = ['PUBLIC', 'API', 'TOKENS'].join('_');
  const prevSingle = process.env[singleEnvKey];
  const prevMulti = process.env[multiEnvKey];
  try {
    process.env[singleEnvKey] = 'alpha';
    process.env[multiEnvKey] = 'beta, gamma';
    assert.deepEqual(getConfiguredEnvApiTokens(), ['alpha', 'beta', 'gamma']);
  } finally {
    if (prevSingle === undefined) delete process.env[singleEnvKey];
    else process.env[singleEnvKey] = prevSingle;
    if (prevMulti === undefined) delete process.env[multiEnvKey];
    else process.env[multiEnvKey] = prevMulti;
  }

  // 1) Revocation during retry backoff stops event retries and sends terminated envelope instead
  const retryStore = new InMemoryMcpEventsStore();
  const retryDeliveries: Array<Record<string, unknown>> = [];
  const retrySecret = makeWebhookSecret(32);
  const retryUrl = 'https://hooks.retry-revoke.example/mcp';

  let attemptNum = 0;
  const retryDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    retryDeliveries.push(parsed);
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.type === 'terminated') {
      return { ok: true, status: 200, bodyText: 'ok' };
    }
    attemptNum += 1;
    if (attemptNum === 1) {
      // Revoke OAuth grant right after first failed attempt (during backoff before attempt 2)
      retryStore.revokeOAuthFamily('fam-retry');
      return { ok: false, status: 503, errorCategory: 'http_5xx' };
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };

  const retryHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: retryStore,
    deliverEventWebhook: retryDeliverFn,
    eventRetryDelaysMs: [5, 5],
  });

  const retryAuth = makeAuthInfo('oauth:42:retry-client', ['mcp:read'], {
    source: 'oauth',
    actor: 'github:musketyr',
    oauthFamilyId: 'fam-retry',
  });
  const subRetry = await callEventsRpc(
    retryHandler,
    'events/subscribe',
    {
      name: 'pr_review.completed',
      delivery: { mode: 'webhook', url: retryUrl, secret: retrySecret },
    },
    { authInfo: retryAuth },
  );
  assert.equal(subRetry.json.error, undefined);

  retryDeliveries.length = 0;
  await publishMcpEvent(
    retryStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 900,
      headSha: 'a'.repeat(40),
      checks: [{ checkId: 900, checkName: 'Code Review', conclusion: 'failure' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: retryDeliverFn, retryDelaysMs: [5, 5], awaitDeliveries: true },
  );
  // Attempt 1 sent the event and got 503; attempt 2 detected revocation and sent ONLY terminated (no 2nd event POST)
  assert.equal(retryDeliveries.length, 2);
  assert.equal(retryDeliveries[0].name, 'pr_review.completed');
  assert.equal(retryDeliveries[1].type, 'terminated');
  assert.equal((retryDeliveries[1].error as { code: number }).code, EventsErrorCode.Forbidden);

  // 2) Backlog > 50 matching events replays the NEWEST 50 in ascending order and sets truncated=true
  const backlogStore = new InMemoryMcpEventsStore();
  for (let i = 1; i <= 60; i += 1) {
    await backlogStore.insertEvent(
      buildPrReviewCheckCompletedPayload({
        checkId: 1000 + i,
        repo: 'telegraphic-dev/jean-ci',
        prNumber: i,
        headSha: 'b'.repeat(40),
        checkName: 'Code Review',
        conclusion: 'success',
        baseUrl: 'https://jean-ci.example.com',
      }),
    );
  }
  const replayedPrNumbers: number[] = [];
  const backlogDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.data?.prNumber !== undefined) {
      replayedPrNumbers.push(parsed.data.prNumber);
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };
  const backlogHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: backlogStore,
    deliverEventWebhook: backlogDeliverFn,
    eventRetryDelaysMs: [0],
  });

  const backlogSub = await callEventsRpc(backlogHandler, 'events/subscribe', {
    name: 'pr_review.check_completed',
    delivery: { mode: 'webhook', url: 'https://hooks.backlog.example/mcp', secret: makeWebhookSecret(32) },
    cursor: 'evt_v1_0',
  });
  assert.equal(backlogSub.json.result?.truncated, true);
  assert.equal(backlogSub.json.result?.cursor, 'evt_v1_10');
  // Wait briefly for async replay loop to finish
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(replayedPrNumbers.length, 50);
  assert.equal(replayedPrNumbers[0], 11);
  assert.equal(replayedPrNumbers[49], 60);

  // 3) Refreshing a suspended subscription preserves acknowledged watermark and recovers missed events
  const suspendStore = new InMemoryMcpEventsStore();
  const recoveredPrs: number[] = [];
  const suspendSecret = makeWebhookSecret(32);
  const suspendUrl = 'https://hooks.suspend.example/mcp';
  const suspendDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.data?.prNumber !== undefined) {
      recoveredPrs.push(parsed.data.prNumber);
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };
  const suspendHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: suspendStore,
    deliverEventWebhook: suspendDeliverFn,
    eventRetryDelaysMs: [0],
  });

  const initialSub = await callEventsRpc(suspendHandler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { mode: 'webhook', url: suspendUrl, secret: suspendSecret },
  });
  assert.equal(initialSub.json.result?.cursor, 'evt_v1_0');

  // Simulate suspension after repeated failures
  const keyHash = deriveSubscriptionIdentity(
    'oauth:42:clienthash123456',
    suspendUrl,
    'pr_review.completed',
    { repo: 'telegraphic-dev/jean-ci' },
  ).subscriptionKeyHash;
  await suspendStore.updateDeliveryStatus({
    subscriptionKeyHash: keyHash,
    active: false,
    consecutiveFailures: 10,
    lastError: 'http_5xx',
    failedSince: new Date(),
  });

  // Insert 2 matching events while suspended (not delivered because active=false)
  await publishMcpEvent(
    suspendStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 301,
      headSha: 'c'.repeat(40),
      checks: [{ checkId: 301, checkName: 'Code Review', conclusion: 'failure' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: suspendDeliverFn, retryDelaysMs: [0], awaitDeliveries: true },
  );
  await publishMcpEvent(
    suspendStore,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 302,
      headSha: 'd'.repeat(40),
      checks: [{ checkId: 302, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: suspendDeliverFn, retryDelaysMs: [0], awaitDeliveries: true },
  );
  assert.deepEqual(recoveredPrs, []);

  // Refresh reactivates subscription, reports prior active=false status, does NOT skip missed events, and replays them!
  const reactivated = await callEventsRpc(suspendHandler, 'events/subscribe', {
    name: 'pr_review.completed',
    arguments: { repo: 'telegraphic-dev/jean-ci' },
    delivery: { mode: 'webhook', url: suspendUrl, secret: suspendSecret },
  });
  assert.equal((reactivated.json.result?.deliveryStatus as { active: boolean }).active, false);
  assert.equal(reactivated.json.result?.cursor, 'evt_v1_0');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(recoveredPrs, [301, 302]);
});

test('replay preserves watermark on unresolved failure, continues on 410 discard, coordinates with live delivery, and stops on mid-replay unsubscribe', async () => {
  // 1) Replay fails on event 1 -> stops before event 2, preserves watermark at 0,
  //    concurrent live event 3 succeeding does NOT advance watermark past 0,
  //    and subsequent refresh recovers events 1, 2, 3 in order.
  const store = new InMemoryMcpEventsStore();
  for (const pr of [1, 2]) {
    await store.insertEvent(
      buildPrReviewCompletedPayload({
        repo: 'telegraphic-dev/jean-ci',
        prNumber: pr,
        headSha: String(pr).repeat(40),
        checks: [{ checkId: pr, checkName: 'Code Review', conclusion: 'success' }],
        baseUrl: 'https://jean-ci.example.com',
      }),
    );
  }

  let failPr1 = true;
  const receivedPrs: number[] = [];
  const secret = makeWebhookSecret(32);
  const url = 'https://hooks.watermark.example/mcp';
  const deliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    const pr = parsed.data?.prNumber;
    if (pr === 1 && failPr1) {
      return { ok: false, status: 503, errorCategory: 'http_5xx' };
    }
    if (pr !== undefined) {
      receivedPrs.push(pr);
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };

  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: store,
    deliverEventWebhook: deliverFn,
    eventRetryDelaysMs: [0],
  });

  const subRes = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    delivery: { mode: 'webhook', url, secret },
    cursor: 'evt_v1_0',
  });
  assert.equal(subRes.json.error, undefined);
  await new Promise((r) => setTimeout(r, 30));

  // Replay stopped after PR #1 failed; PR #2 was NOT delivered ahead of #1
  assert.deepEqual(receivedPrs, []);
  const keyHash = deriveSubscriptionIdentity(
    'oauth:42:clienthash123456',
    url,
    'pr_review.completed',
    {},
  ).subscriptionKeyHash;
  const afterFailSub = await store.getSubscriptionByKeyHash(keyHash);
  assert.equal(afterFailSub?.lastCursorId, 0);
  assert.equal(afterFailSub?.consecutiveFailures, 1);

  // Now publish live event #3 while event #1 is unresolved: even though #3 gets 200 OK,
  // lastCursorId MUST remain 0 so #1 (and #2) are not permanently skipped.
  await publishMcpEvent(
    store,
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 3,
      headSha: '3'.repeat(40),
      checks: [{ checkId: 3, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
    { deliverWebhook: deliverFn, retryDelaysMs: [0], awaitDeliveries: true },
  );
  assert.deepEqual(receivedPrs, [3]);
  const afterLiveSub = await store.getSubscriptionByKeyHash(keyHash);
  assert.equal(afterLiveSub?.lastCursorId, 0);
  assert.equal(afterLiveSub?.lastError, 'http_5xx');

  // Fix endpoint and refresh -> reports prior failure and recovers #1, #2, #3 in order, advancing watermark to 3
  failPr1 = false;
  receivedPrs.length = 0;
  const refreshRes = await callEventsRpc(handler, 'events/subscribe', {
    name: 'pr_review.completed',
    delivery: { mode: 'webhook', url, secret },
  });
  assert.equal((refreshRes.json.result?.deliveryStatus as { lastError: string }).lastError, 'http_5xx');
  assert.equal(refreshRes.json.result?.cursor, 'evt_v1_0');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(receivedPrs, [1, 2, 3]);
  const recoveredSub = await store.getSubscriptionByKeyHash(keyHash);
  assert.equal(recoveredSub?.lastCursorId, 3);
  assert.equal(recoveredSub?.consecutiveFailures, 0);
  assert.equal(recoveredSub?.lastError, null);

  // 2) Explicit 410 Gone discard DOES advance past the discarded event and continues replay to event 2
  const discardStore = new InMemoryMcpEventsStore();
  for (const pr of [10, 11]) {
    await discardStore.insertEvent(
      buildPrReviewCompletedPayload({
        repo: 'telegraphic-dev/jean-ci',
        prNumber: pr,
        headSha: 'e'.repeat(40),
        checks: [{ checkId: pr, checkName: 'Code Review', conclusion: 'success' }],
        baseUrl: 'https://jean-ci.example.com',
      }),
    );
  }
  const discardDelivered: number[] = [];
  const discardDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.data?.prNumber === 10) {
      return { ok: false, status: 410, errorCategory: 'http_4xx' };
    }
    if (parsed.data?.prNumber !== undefined) discardDelivered.push(parsed.data.prNumber);
    return { ok: true, status: 200, bodyText: 'ok' };
  };
  const discardHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: discardStore,
    deliverEventWebhook: discardDeliverFn,
    eventRetryDelaysMs: [0],
  });
  await callEventsRpc(discardHandler, 'events/subscribe', {
    name: 'pr_review.completed',
    delivery: { mode: 'webhook', url: 'https://hooks.discard.example/mcp', secret },
    cursor: 'evt_v1_0',
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(discardDelivered, [11]);

  // 3) Unsubscribing mid-replay stops subsequent queued replay events before attempt 0
  const unsubStore = new InMemoryMcpEventsStore();
  for (const pr of [21, 22, 23]) {
    await unsubStore.insertEvent(
      buildPrReviewCompletedPayload({
        repo: 'telegraphic-dev/jean-ci',
        prNumber: pr,
        headSha: 'f'.repeat(40),
        checks: [{ checkId: pr, checkName: 'Code Review', conclusion: 'success' }],
        baseUrl: 'https://jean-ci.example.com',
      }),
    );
  }
  const unsubUrl = 'https://hooks.unsub-mid.example/mcp';
  const unsubKeyHash = deriveSubscriptionIdentity(
    'oauth:42:clienthash123456',
    unsubUrl,
    'pr_review.completed',
    {},
  ).subscriptionKeyHash;
  const unsubDelivered: number[] = [];
  const unsubDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.data?.prNumber !== undefined) {
      unsubDelivered.push(parsed.data.prNumber);
      if (parsed.data.prNumber === 21) {
        // Delete subscription immediately during first replayed event delivery
        await unsubStore.deleteSubscriptionByKeyHash(unsubKeyHash);
      }
    }
    return { ok: true, status: 200, bodyText: 'ok' };
  };
  const unsubHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: unsubStore,
    deliverEventWebhook: unsubDeliverFn,
    eventRetryDelaysMs: [0],
  });
  await callEventsRpc(unsubHandler, 'events/subscribe', {
    name: 'pr_review.completed',
    delivery: { mode: 'webhook', url: unsubUrl, secret },
    cursor: 'evt_v1_0',
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(unsubDelivered, [21]);
});

test('runPRReview never emits overallConclusion=success when an expected check fails to create or persist', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';

    const dbExports = await import('./lib/db.ts');
    let nextDbId = 600;
    let failSecondInsert = true;
    let failSecondPersist = false;
    mock.module('./lib/db.ts', {
      namedExports: {
        ...dbExports,
        getRepo: async () => ({ full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Review this PR.',
        DEFAULT_USER_PROMPT: 'Review this PR.',
        insertCheckRun: async ({ check_name }) => {
          if (failSecondInsert && check_name === 'Second Check') {
            throw new Error('DB insert failure for second check');
          }
          nextDbId += 1;
          return nextDbId;
        },
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async (id) => {
          if (failSecondPersist && id === 603) {
            throw new Error('DB terminal persist failure');
          }
        },
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        getPRDiff: async () => 'diff --git a/a.ts b/a.ts\\n+export const ok = true;\\n',
        getPRInfo: async () => ({ title: 'Test PR', body: 'Body', head: { sha: '${'a'.repeat(40)}' } }),
        createCheck: async (_octo, _o, _r, name) => ({ id: name.includes('Second') ? 902 : 901 }),
        updateCheck: async () => {},
        createPRReview: async () => {},
        fetchPRCheckFiles: async () => [
          { path: '.jean-ci/second.md', name: 'Second Check', prompt: 'Check second rule.' },
        ],
      },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async () => ({
          success: true,
          response: 'VERDICT: PASS\\nTITLE: Looks good\\nSUMMARY: Passed.',
        }),
      },
    });

    const { InMemoryMcpEventsStore } = await import('./lib/mcp/events.ts');
    const { runPRReview } = await import('./lib/pr-review.ts');

    // Case 1: 2 expected checks, check 1 succeeds, check 2 fails to create
    const store1 = new InMemoryMcpEventsStore();
    await runPRReview(1, 'acme', 'app', 88, '${'a'.repeat(40)}', undefined, {
      mcpEventsStore: store1,
    });
    const prEvents1 = await store1.queryEvents({ name: 'pr_review.completed', afterId: 0, limit: 10 });
    assert.equal(prEvents1.length, 1);
    assert.equal(prEvents1[0].data.overallConclusion, 'failure');
    assert.equal(prEvents1[0].data.incomplete, true);
    assert.equal(prEvents1[0].data.checksCount, 1);
    assert.equal(prEvents1[0].data.expectedChecksCount, 2);
    assert.equal(prEvents1[0].data.incompleteChecksCount, 1);

    // Case 2: 2 expected checks, both created (ids 602 & 603), check 2 fails to persist terminal status
    failSecondInsert = false;
    failSecondPersist = true;
    const store2 = new InMemoryMcpEventsStore();
    await runPRReview(1, 'acme', 'app', 89, '${'a'.repeat(40)}', undefined, {
      mcpEventsStore: store2,
    });
    const prEvents2 = await store2.queryEvents({ name: 'pr_review.completed', afterId: 0, limit: 10 });
    assert.equal(prEvents2.length, 1);
    assert.equal(prEvents2[0].data.overallConclusion, 'failure');
    assert.equal(prEvents2[0].data.incomplete, true);
    assert.equal(prEvents2[0].data.checksCount, 1);
    assert.equal(prEvents2[0].data.expectedChecksCount, 2);
    assert.equal(prEvents2[0].data.incompleteChecksCount, 1);
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
    },
  );
});

test('expired subscription replacement resets watermark, detached replay rejects safely, and successive approval prompts emit distinct events', async () => {
  const secret = makeWebhookSecret(32);

  // 1) Replacing an expired subscription resets lastCursorId instead of preserving the expired high watermark
  const expStore = new InMemoryMcpEventsStore();
  for (let pr = 1; pr <= 5; pr += 1) {
    await expStore.insertEvent(
      buildPrReviewCompletedPayload({
        repo: 'telegraphic-dev/jean-ci',
        prNumber: pr,
        headSha: String(pr).repeat(40),
        checks: [{ checkId: pr, checkName: 'Code Review', conclusion: 'success' }],
        baseUrl: 'https://jean-ci.example.com',
      }),
    );
  }
  const expUrl = 'https://hooks.expired-reset.example/mcp';
  const expKeyHash = deriveSubscriptionIdentity(
    'oauth:42:clienthash123456',
    expUrl,
    'pr_review.completed',
    {},
  ).subscriptionKeyHash;

  // Insert an already-expired subscription row with high watermark = 5 (simulating pre-cleanup DB row)
  await expStore.upsertSubscription({
    subscriptionKeyHash: expKeyHash,
    subscriptionId: 'sub_expired_old',
    principal: 'oauth:42:clienthash123456',
    oauthTokenFamilyId: null,
    eventName: 'pr_review.completed',
    arguments: {},
    callbackUrl: expUrl,
    secret,
    previousSecret: null,
    previousSecretExpiresAt: null,
    expiresAt: new Date(Date.now() - 60_000),
    lastCursorId: 5,
  });

  const replayedAfterExpiry: number[] = [];
  const expDeliverFn: WebhookDeliverFn = async ({ rawBody }) => {
    const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string; data?: { prNumber?: number } };
    if (parsed.type === 'verification') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
    }
    if (parsed.data?.prNumber !== undefined) replayedAfterExpiry.push(parsed.data.prNumber);
    return { ok: true, status: 200, bodyText: 'ok' };
  };
  const expHandler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: expStore,
    deliverEventWebhook: expDeliverFn,
    eventRetryDelaysMs: [0],
  });

  // Resubscribe with cursor=evt_v1_2: should reset watermark from expired 5 to 2 and replay PRs 3, 4, 5!
  const recreated = await callEventsRpc(expHandler, 'events/subscribe', {
    name: 'pr_review.completed',
    delivery: { mode: 'webhook', url: expUrl, secret },
    cursor: 'evt_v1_2',
  });
  assert.equal(recreated.json.result?.cursor, 'evt_v1_2');
  assert.equal(recreated.json.result?.truncated, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(replayedAfterExpiry, [3, 4, 5]);
  const updatedSub = await expStore.getSubscriptionByKeyHash(expKeyHash);
  assert.equal(updatedSub?.lastCursorId, 5);

  // 2) Detached replay catching store.getSubscriptionByKeyHash rejection produces NO unhandledRejection
  const flakyStore = new InMemoryMcpEventsStore();
  await flakyStore.insertEvent(
    buildPrReviewCompletedPayload({
      repo: 'telegraphic-dev/jean-ci',
      prNumber: 99,
      headSha: '9'.repeat(40),
      checks: [{ checkId: 99, checkName: 'Code Review', conclusion: 'success' }],
      baseUrl: 'https://jean-ci.example.com',
    }),
  );
  let getSubCalls = 0;
  const origGetSub = flakyStore.getSubscriptionByKeyHash.bind(flakyStore);
  flakyStore.getSubscriptionByKeyHash = async (keyHash: string) => {
    getSubCalls += 1;
    // Call 1 is inside events/subscribe; Call 2 is inside the detached replay loop
    if (getSubCalls >= 2) {
      throw new Error('simulated transient DB outage during replay');
    }
    return origGetSub(keyHash);
  };

  let unhandledCount = 0;
  const onUnhandled = () => {
    unhandledCount += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const flakyHandler = createJeanCiMcpHandler({
      baseUrl: 'https://jean-ci.example.com',
      taskStore: new InMemoryMcpTaskStore(),
      taskAbortRegistry: new McpTaskAbortRegistry(),
      eventsStore: flakyStore,
      deliverEventWebhook: async ({ rawBody }) => {
        const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string };
        return { ok: true, status: 200, bodyText: JSON.stringify({ challenge: parsed.challenge }) };
      },
      eventRetryDelaysMs: [0],
    });
    const res = await callEventsRpc(flakyHandler, 'events/subscribe', {
      name: 'pr_review.completed',
      delivery: { mode: 'webhook', url: 'https://hooks.flaky-replay.example/mcp', secret },
      cursor: 'evt_v1_0',
    });
    assert.equal(res.json.error, undefined);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(unhandledCount, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  // 3) Successive Hermes approval prompts in the same check emit distinct pr_review.approval_required events
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';

    const dbExports = await import('./lib/db.ts');
    let currentPrompts = [
      { prompt_id: 'prompt-1', execution_generation: 0, choices: ['once', 'deny'] },
    ];
    mock.module('./lib/db.ts', {
      namedExports: {
        ...dbExports,
        getRepo: async () => ({ full_name: 'acme/app', installation_id: 1, pr_review_enabled: true }),
        getConfig: async () => 'Review this PR.',
        DEFAULT_USER_PROMPT: 'Review this PR.',
        insertCheckRun: async () => 701,
        setCheckRunGithubId: async () => {},
        setReservedCheckInput: async () => {},
        updateCheckRun: async () => {},
        reviewRunStore: {
          ...dbExports.reviewRunStore,
          get: async () => [
            { segment: 1, run_id: 'run-abc', status: 'waiting', pending: currentPrompts, history: [] },
          ],
        },
      },
    });
    mock.module('./lib/github.ts', {
      namedExports: {
        getInstallationOctokit: async () => ({}),
        getPRDiff: async () => 'diff --git a/a.ts b/a.ts\\n+export const ok = true;\\n',
        getPRInfo: async () => ({ title: 'Test PR', body: 'Body', head: { sha: '${'a'.repeat(40)}' } }),
        createCheck: async () => ({ id: 970 }),
        updateCheck: async () => {},
        createPRReview: async () => {},
        fetchPRCheckFiles: async () => [],
      },
    });
    mock.module('./lib/review-approval-comments.ts', {
      namedExports: { postReviewApprovalComments: async () => {} },
    });
    mock.module('./lib/review-approvals.ts', {
      namedExports: { notifyReviewApproval: async () => {} },
    });
    mock.module('./lib/llm.ts', {
      namedExports: {
        callOpenClaw: async (_prompt, _ctx, meta) => {
          // Poll 1 & Poll 2 for first approval prompt -> should emit ONCE
          await meta.onWaiting();
          await meta.onWaiting();
          // Run resumes and pauses again for a second approval prompt -> should emit a SECOND distinct event!
          currentPrompts = [
            { prompt_id: 'prompt-2', execution_generation: 1, choices: ['once', 'deny'] },
          ];
          await meta.onWaiting();
          return {
            success: true,
            response: 'VERDICT: PASS\\nTITLE: Looks good\\nSUMMARY: Approved and passed.',
          };
        },
      },
    });

    const { InMemoryMcpEventsStore } = await import('./lib/mcp/events.ts');
    const { runPRReview } = await import('./lib/pr-review.ts');
    const store = new InMemoryMcpEventsStore();
    await runPRReview(1, 'acme', 'app', 91, '${'a'.repeat(40)}', undefined, {
      mcpEventsStore: store,
    });
    const approvalEvents = await store.queryEvents({
      name: 'pr_review.approval_required',
      afterId: 0,
      limit: 10,
    });
    assert.equal(approvalEvents.length, 2);
    assert.notEqual(approvalEvents[0].eventId, approvalEvents[1].eventId);
    assert.equal(approvalEvents[0].data.promptId, 'prompt-1');
    assert.equal(approvalEvents[0].data.executionGeneration, 0);
    assert.equal(approvalEvents[1].data.promptId, 'prompt-2');
    assert.equal(approvalEvents[1].data.executionGeneration, 1);
  `;

  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
    },
  );
});




