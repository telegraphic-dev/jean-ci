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

