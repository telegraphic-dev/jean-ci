import { createHash, createHmac, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  advanceMcpEventSubscriptionCursor,
  countActiveMcpEventSubscriptionsForPrincipal,
  deleteMcpEventSubscriptionByKeyHash,
  getMcpEventStreamBounds,
  getMcpEventSubscriptionByKeyHash,
  hasActiveMcpOAuthFamily,
  hasSkippedMcpEventsBeforeFloor,
  insertMcpEvent,
  isApiTokenActive,
  isMcpEventEndpointVerified,
  listActiveMcpEventSubscriptionsByEventName,
  markMcpEventEndpointVerified,
  McpEventSubscriptionQuotaExceededError,
  queryMcpEvents,
  updateMcpEventSubscriptionDeliveryStatus,
  upsertMcpEventSubscription,
  type McpEventDbRecord,
  type McpEventSubscriptionDbRecord,
} from '../db.ts';
import { isPrivateIpAddress, timingSafeEqualStrings } from './oauth.ts';

/** Official MCP Events extension identifier (SEP-3415, Beta). */
export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

/** SEP-3415 JSON-RPC error codes. */
export const EventsErrorCode = {
  HeaderMismatch: -32020,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
  InvalidParams: ProtocolErrorCode.InvalidParams,
} as const;

export type McpEventName =
  | 'pr_review.completed'
  | 'pr_review.check_completed'
  | 'pr_review.approval_required';

export type WebhookErrorCategory =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed';

export type ReviewConclusion = 'success' | 'failure' | 'neutral';

export interface McpEventRecord {
  id: number;
  eventId: string;
  name: McpEventName;
  repo: string | null;
  prNumber: number | null;
  conclusion: string | null;
  checkName: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface McpEventSubscription {
  subscriptionKeyHash: string;
  subscriptionId: string;
  principal: string;
  oauthTokenFamilyId: string | null;
  eventName: McpEventName;
  arguments: Record<string, unknown>;
  callbackUrl: string;
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
  expiresAt: Date;
  lastCursorId: number;
  active: boolean;
  consecutiveFailures: number;
  lastDeliveryAt: Date | null;
  lastError: WebhookErrorCategory | null;
  failedSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpEventDeliveryStatus {
  active: boolean;
  lastDeliveryAt: string | null;
  lastError: WebhookErrorCategory | null;
  failedSince?: string;
}

export interface McpEventsStore {
  insertEvent(input: {
    eventId: string;
    name: McpEventName;
    repo?: string | null;
    prNumber?: number | null;
    conclusion?: string | null;
    checkName?: string | null;
    data: Record<string, unknown>;
  }): Promise<McpEventRecord>;
  getStreamBounds(): Promise<{ latestId: number; oldestId: number | null }>;
  queryEvents(params: {
    name: McpEventName;
    afterId: number;
    minCreatedAt?: Date | null;
    repo?: string;
    prNumber?: number;
    conclusion?: string;
    checkName?: string;
    limit: number;
    order?: 'asc' | 'desc';
  }): Promise<McpEventRecord[]>;
  hasSkippedEventsBeforeFloor(params: {
    name: McpEventName;
    afterId: number;
    minCreatedAt: Date;
  }): Promise<boolean>;
  getSubscriptionByKeyHash(keyHash: string): Promise<McpEventSubscription | null>;
  countActiveSubscriptions(principal: string): Promise<number>;
  upsertSubscription(input: {
    subscriptionKeyHash: string;
    subscriptionId: string;
    principal: string;
    oauthTokenFamilyId: string | null;
    eventName: McpEventName;
    arguments: Record<string, unknown>;
    callbackUrl: string;
    secret: string;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
    expiresAt: Date;
    lastCursorId: number;
    maxActivePerPrincipal?: number;
  }): Promise<McpEventSubscription>;
  advanceSubscriptionCursor(keyHash: string, minCursorId: number): Promise<void>;
  deleteSubscriptionByKeyHash(keyHash: string): Promise<boolean>;
  listActiveSubscriptions(eventName: McpEventName): Promise<McpEventSubscription[]>;
  updateDeliveryStatus(params: {
    subscriptionKeyHash: string;
    active: boolean;
    consecutiveFailures: number;
    lastDeliveryAt?: Date | null;
    lastError: WebhookErrorCategory | null;
    failedSince?: Date | null;
    lastCursorId?: number;
  }): Promise<void>;
  isEndpointVerified(principal: string, callbackUrl: string): Promise<boolean>;
  markEndpointVerified(principal: string, callbackUrl: string, expiresAt: Date): Promise<void>;
  isPrincipalAuthorized(sub: McpEventSubscription): Promise<boolean>;
}

const CURSOR_PREFIX = 'evt_v1_';
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_EVENTS = 50;
const MAX_POLL_EVENTS = 100;
const DEFAULT_WEBHOOK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_WEBHOOK_TTL_MS = 60 * 1000; // 60 seconds
const MAX_WEBHOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERIFICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SECRET_ROTATION_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SUBSCRIPTIONS_PER_PRINCIPAL = 25;
const MAX_WEBHOOK_RESPONSE_BYTES = 16 * 1024;
const WEBHOOK_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES_BEFORE_SUSPEND = 10;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RepoFilterSchema = z.string().trim().regex(REPO_SLUG_REGEX, 'repo must be in owner/repo format');
const ConclusionFilterSchema = z.enum(['success', 'failure', 'neutral']);

const PrReviewCompletedArgsSchema = z
  .object({
    repo: RepoFilterSchema.optional(),
    prNumber: z.number().int().positive().optional(),
    conclusion: ConclusionFilterSchema.optional(),
  })
  .strict();

const PrReviewCheckCompletedArgsSchema = z
  .object({
    repo: RepoFilterSchema.optional(),
    prNumber: z.number().int().positive().optional(),
    checkName: z.string().trim().min(1).max(200).optional(),
    conclusion: ConclusionFilterSchema.optional(),
  })
  .strict();

const PrReviewApprovalRequiredArgsSchema = z
  .object({
    repo: RepoFilterSchema.optional(),
    prNumber: z.number().int().positive().optional(),
  })
  .strict();

export interface McpEventTypeDescriptor {
  name: McpEventName;
  description: string;
  delivery: Array<'poll' | 'webhook'>;
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export const MCP_EVENT_DESCRIPTORS: readonly McpEventTypeDescriptor[] = [
  {
    name: 'pr_review.completed',
    description:
      'Fires once a Jean CI PR review run finishes executing its checks for a pull request commit. Carries minimal triage metadata; call get_pr_reviews or get_review_check for full findings.',
    delivery: ['poll', 'webhook'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
          description: 'Optional repository filter in owner/repo format.',
        },
        prNumber: {
          type: 'integer',
          minimum: 1,
          description: 'Optional pull request number filter.',
        },
        conclusion: {
          type: 'string',
          enum: ['success', 'failure', 'neutral'],
          description: 'Optional overall review conclusion filter.',
        },
      },
    },
    payloadSchema: {
      type: 'object',
      required: [
        'repo',
        'prNumber',
        'headSha',
        'overallConclusion',
        'checksCount',
        'expectedChecksCount',
        'incompleteChecksCount',
        'incomplete',
        'failedCount',
        'checks',
        'prUrl',
      ],
      properties: {
        repo: { type: 'string' },
        prNumber: { type: 'integer' },
        headSha: { type: 'string' },
        overallConclusion: { type: 'string', enum: ['success', 'failure', 'neutral'] },
        checksCount: { type: 'integer' },
        expectedChecksCount: { type: 'integer' },
        incompleteChecksCount: { type: 'integer' },
        incomplete: { type: 'boolean' },
        failedCount: { type: 'integer' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['checkId', 'checkName', 'conclusion', 'detailsUrl'],
            properties: {
              checkId: { type: 'integer' },
              checkName: { type: 'string' },
              checkIdentity: { type: ['string', 'null'] },
              conclusion: { type: 'string', enum: ['success', 'failure', 'neutral'] },
              detailsUrl: { type: 'string', format: 'uri' },
            },
          },
        },
        prUrl: { type: 'string', format: 'uri' },
      },
    },
  },
  {
    name: 'pr_review.check_completed',
    description:
      'Fires when an individual Jean CI PR review check run finishes. Call get_review_check with checkId to inspect detailed review findings.',
    delivery: ['poll', 'webhook'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
          description: 'Optional repository filter in owner/repo format.',
        },
        prNumber: {
          type: 'integer',
          minimum: 1,
          description: 'Optional pull request number filter.',
        },
        checkName: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Optional case-insensitive check name filter (e.g. "Code Review" or "security").',
        },
        conclusion: {
          type: 'string',
          enum: ['success', 'failure', 'neutral'],
          description: 'Optional check conclusion filter.',
        },
      },
    },
    payloadSchema: {
      type: 'object',
      required: ['checkId', 'repo', 'prNumber', 'headSha', 'checkName', 'conclusion', 'detailsUrl', 'prUrl'],
      properties: {
        checkId: { type: 'integer' },
        repo: { type: 'string' },
        prNumber: { type: 'integer' },
        headSha: { type: 'string' },
        checkName: { type: 'string' },
        checkIdentity: { type: ['string', 'null'] },
        conclusion: { type: 'string', enum: ['success', 'failure', 'neutral'] },
        detailsUrl: { type: 'string', format: 'uri' },
        prUrl: { type: 'string', format: 'uri' },
      },
    },
  },
  {
    name: 'pr_review.approval_required',
    description:
      'Fires when a Hermes PR review check pauses waiting for a human GitHub administrator tool-approval decision at /checks/<checkId>. Never exposes tool commands or approval actions.',
    delivery: ['poll', 'webhook'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
          description: 'Optional repository filter in owner/repo format.',
        },
        prNumber: {
          type: 'integer',
          minimum: 1,
          description: 'Optional pull request number filter.',
        },
      },
    },
    payloadSchema: {
      type: 'object',
      required: ['checkId', 'repo', 'prNumber', 'headSha', 'checkName', 'detailsUrl', 'prUrl'],
      properties: {
        checkId: { type: 'integer' },
        repo: { type: 'string' },
        prNumber: { type: 'integer' },
        headSha: { type: 'string' },
        checkName: { type: 'string' },
        segment: { type: 'integer' },
        executionGeneration: { type: 'integer' },
        promptId: { type: 'string' },
        detailsUrl: { type: 'string', format: 'uri' },
        prUrl: { type: 'string', format: 'uri' },
      },
    },
  },
];

const EVENT_NAMES = new Set<string>(MCP_EVENT_DESCRIPTORS.map((d) => d.name));

export function isKnownMcpEventName(name: string): name is McpEventName {
  return EVENT_NAMES.has(name);
}

export function encodeEventCursor(seq: number): string {
  return `${CURSOR_PREFIX}${Math.max(0, Math.floor(seq))}`;
}

export function decodeEventCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new ProtocolError(EventsErrorCode.InvalidParams, `Invalid event cursor: ${String(cursor)}`);
  }
  const numPart = cursor.slice(CURSOR_PREFIX.length);
  if (!/^\d+$/.test(numPart)) {
    throw new ProtocolError(EventsErrorCode.InvalidParams, `Invalid event cursor: ${cursor}`);
  }
  const parsed = Number(numPart);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProtocolError(EventsErrorCode.InvalidParams, `Invalid event cursor: ${cursor}`);
  }
  return parsed;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export function deriveSubscriptionIdentity(
  principal: string,
  callbackUrl: string,
  eventName: McpEventName,
  args: Record<string, unknown>,
): { subscriptionKeyHash: string; subscriptionId: string } {
  const canonicalKey = `${principal}\0${callbackUrl}\0${eventName}\0${canonicalJson(args)}`;
  const subscriptionKeyHash = createHash('sha256').update(canonicalKey).digest('hex');
  return {
    subscriptionKeyHash,
    subscriptionId: `sub_${subscriptionKeyHash.slice(0, 16)}`,
  };
}

/**
 * Validates a Standard Webhooks symmetric signing secret per SEP-3415:
 * literal prefix "whsec_" followed by base64 decoding to 24..64 bytes.
 */
export function parseWebhookSecretBytes(secret: string): Buffer | null {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return null;
  const b64 = secret.slice(6);
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const decoded = Buffer.from(b64, 'base64');
  // Verify canonical base64 round-trip to reject malformed trailing bits
  if (decoded.toString('base64') !== b64) return null;
  if (decoded.length < 24 || decoded.length > 64) return null;
  return decoded;
}

export function signStandardWebhook(
  webhookId: string,
  timestampSec: number,
  rawBody: string,
  secrets: string[],
): string {
  const payload = `${webhookId}.${timestampSec}.${rawBody}`;
  const sigs: string[] = [];
  for (const secret of secrets) {
    const key = parseWebhookSecretBytes(secret);
    if (!key) continue;
    const digest = createHmac('sha256', key).update(payload).digest('base64');
    sigs.push(`v1,${digest}`);
  }
  return sigs.join(' ');
}

export function isValidWebhookCallbackUrl(rawUrl: string): URL | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hash || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  const cleanHost = host.replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost) && isPrivateIpAddress(cleanHost)) {
    return null;
  }
  return parsed;
}

export function validateEventArguments(
  name: McpEventName,
  rawArgs: unknown,
): Record<string, unknown> {
  const input = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  const schema =
    name === 'pr_review.completed'
      ? PrReviewCompletedArgsSchema
      : name === 'pr_review.check_completed'
        ? PrReviewCheckCompletedArgsSchema
        : PrReviewApprovalRequiredArgsSchema;

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError(
      EventsErrorCode.InvalidParams,
      `Invalid arguments for event "${name}": ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

export function eventMatchesSubscriptionArgs(
  event: McpEventRecord,
  args: Record<string, unknown>,
): boolean {
  if (typeof args.repo === 'string' && event.repo !== args.repo) return false;
  if (typeof args.prNumber === 'number' && event.prNumber !== args.prNumber) return false;
  if (typeof args.conclusion === 'string' && event.conclusion !== args.conclusion) return false;
  if (
    typeof args.checkName === 'string' &&
    (!event.checkName || event.checkName.toLowerCase() !== args.checkName.toLowerCase())
  ) {
    return false;
  }
  return true;
}

export interface WebhookPostResponse {
  ok: boolean;
  status?: number;
  bodyText?: string;
  errorCategory?: WebhookErrorCategory;
}

export type WebhookDeliverFn = (params: {
  url: URL;
  rawBody: string;
  headers: Record<string, string>;
}) => Promise<WebhookPostResponse>;

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

function classifyNetworkError(err: unknown): WebhookErrorCategory {
  const e = err as { code?: string; name?: string; message?: string } | null;
  const code = String(e?.code || '').toUpperCase();
  const name = String(e?.name || '');
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'timeout';
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('UNABLE_TO_VERIFY') ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER'
  ) {
    return 'tls_error';
  }
  return 'connection_refused';
}

/**
 * SSRF-hardened pinned-DNS HTTPS webhook delivery per SEP-3415 §Webhook security:
 * validates every resolved IP against IANA private/special ranges at connection time,
 * pins TCP connection directly to the validated IP while preserving Host + TLS SNI,
 * never follows redirects, enforces 5s timeout, and caps response body reads.
 */
export async function deliverWebhookPinnedHttps(
  params: { url: URL; rawBody: string; headers: Record<string, string> },
  lookupFn: DnsLookupFn = (h) => dns.lookup(h, { all: true }),
): Promise<WebhookPostResponse> {
  const { url, rawBody, headers } = params;
  const rawHost = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(rawHost) && isPrivateIpAddress(rawHost)) {
    return { ok: false, errorCategory: 'connection_refused' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    return await new Promise<WebhookPostResponse>((resolve) => {
      let settled = false;
      const finish = (result: WebhookPostResponse) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const pinnedLookup = (
        hostname: string,
        options: unknown,
        callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
      ) => {
        const cb = typeof options === 'function' ? (options as typeof callback) : callback;
        const opts = typeof options === 'object' && options !== null ? (options as { all?: boolean }) : {};
        void lookupFn(hostname)
          .then((entries) => {
            if (!entries.length || entries.some((entry) => isPrivateIpAddress(entry.address))) {
              cb(
                Object.assign(new Error('Blocked private or invalid webhook IP address'), {
                  code: 'ERR_SSRF_BLOCKED',
                }),
                '',
              );
              return;
            }
            const normalized = entries.map((entry) => {
              const family = entry.family === 4 || entry.family === 6 ? entry.family : net.isIP(entry.address);
              return { address: entry.address, family: family === 6 ? 6 : 4 };
            });
            if (opts.all) {
              cb(null, normalized);
            } else {
              cb(null, normalized[0].address, normalized[0].family);
            }
          })
          .catch((err) => cb(err as NodeJS.ErrnoException, ''));
      };

      const bodyBuffer = Buffer.from(rawBody, 'utf8');
      const req = https.request(
        {
          protocol: 'https:',
          hostname: rawHost,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': String(bodyBuffer.byteLength),
            'Accept-Encoding': 'identity',
            'User-Agent': 'jean-ci-mcp-events/1.0',
            Host: url.host,
          },
          servername: net.isIP(rawHost) ? undefined : rawHost,
          lookup: pinnedLookup as unknown as typeof import('node:dns').lookup,
          signal: controller.signal,
        },
        (res) => {
          const status = res.statusCode || 0;
          const chunks: Buffer[] = [];
          let total = 0;

          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            if (total < MAX_WEBHOOK_RESPONSE_BYTES) {
              const remaining = MAX_WEBHOOK_RESPONSE_BYTES - total;
              chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
              total += Math.min(chunk.length, remaining);
            }
          });
          res.on('end', () => {
            const bodyText = Buffer.concat(chunks, total).toString('utf8');
            if (status >= 200 && status < 300) {
              finish({ ok: true, status, bodyText });
            } else if (status >= 400 && status < 500) {
              finish({ ok: false, status, bodyText, errorCategory: 'http_4xx' });
            } else if (status >= 300 && status < 400) {
              // Redirects are explicitly forbidden per SEP-3415 §Webhook security
              finish({ ok: false, status, errorCategory: 'http_4xx' });
            } else {
              finish({ ok: false, status, errorCategory: 'http_5xx' });
            }
          });
          res.on('close', () => {
            if (!settled) finish({ ok: false, errorCategory: 'connection_refused' });
          });
          res.on('error', (err) => finish({ ok: false, errorCategory: classifyNetworkError(err) }));
        },
      );

      req.on('error', (err) => finish({ ok: false, errorCategory: classifyNetworkError(err) }));
      req.write(bodyBuffer);
      req.end();
    });
  } finally {
    clearTimeout(timer);
  }
}

function mapEventRow(row: McpEventDbRecord): McpEventRecord {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    name: row.name as McpEventName,
    repo: row.repo,
    prNumber: row.pr_number,
    conclusion: row.conclusion,
    checkName: row.check_name,
    data: (row.data && typeof row.data === 'object' ? row.data : {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at),
  };
}

function mapSubscriptionRow(row: McpEventSubscriptionDbRecord): McpEventSubscription {
  return {
    subscriptionKeyHash: row.subscription_key_hash,
    subscriptionId: row.subscription_id,
    principal: row.principal,
    oauthTokenFamilyId: row.oauth_token_family_id,
    eventName: row.event_name as McpEventName,
    arguments: (row.arguments_json && typeof row.arguments_json === 'object'
      ? row.arguments_json
      : {}) as Record<string, unknown>,
    callbackUrl: row.callback_url,
    secret: row.secret,
    previousSecret: row.previous_secret,
    previousSecretExpiresAt: row.previous_secret_expires_at ? new Date(row.previous_secret_expires_at) : null,
    expiresAt: new Date(row.expires_at),
    lastCursorId: Number(row.last_cursor_id || 0),
    active: Boolean(row.active),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at) : null,
    lastError: (row.last_error as WebhookErrorCategory | null) ?? null,
    failedSince: row.failed_since ? new Date(row.failed_since) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

let sharedDbEventsStore: McpEventsStore | null = null;

export function createDbMcpEventsStore(): McpEventsStore {
  if (sharedDbEventsStore) return sharedDbEventsStore;
  sharedDbEventsStore = {
    insertEvent: async (input) =>
      mapEventRow(
        await insertMcpEvent({
          eventId: input.eventId,
          name: input.name,
          repo: input.repo,
          prNumber: input.prNumber,
          conclusion: input.conclusion,
          checkName: input.checkName,
          payload: input.data,
        }),
      ),
    getStreamBounds: () => getMcpEventStreamBounds(),
    queryEvents: async (params) => (await queryMcpEvents(params)).map(mapEventRow),
    hasSkippedEventsBeforeFloor: (params) => hasSkippedMcpEventsBeforeFloor(params),
    getSubscriptionByKeyHash: async (keyHash) => {
      const row = await getMcpEventSubscriptionByKeyHash(keyHash);
      return row ? mapSubscriptionRow(row) : null;
    },
    countActiveSubscriptions: (principal) => countActiveMcpEventSubscriptionsForPrincipal(principal),
    upsertSubscription: async (input) =>
      mapSubscriptionRow(
        await upsertMcpEventSubscription({
          subscriptionKeyHash: input.subscriptionKeyHash,
          subscriptionId: input.subscriptionId,
          principal: input.principal,
          oauthTokenFamilyId: input.oauthTokenFamilyId,
          eventName: input.eventName,
          argumentsJson: input.arguments,
          callbackUrl: input.callbackUrl,
          secret: input.secret,
          previousSecret: input.previousSecret,
          previousSecretExpiresAt: input.previousSecretExpiresAt,
          expiresAt: input.expiresAt,
          lastCursorId: input.lastCursorId,
          maxActivePerPrincipal: input.maxActivePerPrincipal,
        }),
      ),
    advanceSubscriptionCursor: (keyHash, minCursorId) =>
      advanceMcpEventSubscriptionCursor(keyHash, minCursorId),
    deleteSubscriptionByKeyHash: (keyHash) => deleteMcpEventSubscriptionByKeyHash(keyHash),
    listActiveSubscriptions: async (eventName) =>
      (await listActiveMcpEventSubscriptionsByEventName(eventName)).map(mapSubscriptionRow),
    updateDeliveryStatus: (params) => updateMcpEventSubscriptionDeliveryStatus(params),
    isEndpointVerified: (principal, callbackUrl) => isMcpEventEndpointVerified(principal, callbackUrl),
    markEndpointVerified: (principal, callbackUrl, expiresAt) =>
      markMcpEventEndpointVerified(principal, callbackUrl, expiresAt),
    isPrincipalAuthorized: async (sub) => {
      if (sub.oauthTokenFamilyId) {
        return hasActiveMcpOAuthFamily(sub.oauthTokenFamilyId);
      }
      if (sub.principal.startsWith('api-token:db:')) {
        const tokenId = Number(sub.principal.slice('api-token:db:'.length));
        if (Number.isInteger(tokenId) && tokenId > 0) {
          return isApiTokenActive(tokenId);
        }
        return false;
      }
      if (sub.principal.startsWith('api-token:env:')) {
        const expectedFp = sub.principal.slice('api-token:env:'.length);
        return getConfiguredEnvApiTokens().some(
          (tok) => createHash('sha256').update(tok).digest('hex').slice(0, 16) === expectedFp,
        );
      }
      return false;
    },
  };
  return sharedDbEventsStore;
}

export function getConfiguredEnvApiTokens(): string[] {
  return [process.env.PUBLIC_API_TOKEN, process.env.PUBLIC_API_TOKENS]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export class InMemoryMcpEventsStore implements McpEventsStore {
  private seq = 0;
  private events: McpEventRecord[] = [];
  private readonly subscriptions = new Map<string, McpEventSubscription>();
  private readonly verifiedEndpoints = new Map<string, Date>();
  private readonly revokedPrincipals = new Set<string>();
  private readonly revokedFamilies = new Set<string>();

  revokePrincipal(principal: string): void {
    this.revokedPrincipals.add(principal);
  }

  revokeOAuthFamily(familyId: string): void {
    this.revokedFamilies.add(familyId);
  }

  pruneEventsBeforeId(minId: number): void {
    this.events = this.events.filter((e) => e.id >= minId);
  }

  async insertEvent(input: {
    eventId: string;
    name: McpEventName;
    repo?: string | null;
    prNumber?: number | null;
    conclusion?: string | null;
    checkName?: string | null;
    data: Record<string, unknown>;
    createdAt?: Date;
  }): Promise<McpEventRecord> {
    const existing = this.events.find((e) => e.eventId === input.eventId);
    if (existing) return existing;
    this.seq += 1;
    const record: McpEventRecord = {
      id: this.seq,
      eventId: input.eventId,
      name: input.name,
      repo: input.repo ?? null,
      prNumber: input.prNumber ?? null,
      conclusion: input.conclusion ?? null,
      checkName: input.checkName ?? null,
      data: { ...input.data },
      createdAt: input.createdAt ?? new Date(),
    };
    this.events.push(record);
    return record;
  }

  async getStreamBounds(): Promise<{ latestId: number; oldestId: number | null }> {
    return {
      latestId: this.seq,
      oldestId: this.events.length > 0 ? this.events[0].id : null,
    };
  }

  async queryEvents(params: {
    name: McpEventName;
    afterId: number;
    minCreatedAt?: Date | null;
    repo?: string;
    prNumber?: number;
    conclusion?: string;
    checkName?: string;
    limit: number;
    order?: 'asc' | 'desc';
  }): Promise<McpEventRecord[]> {
    const matched = this.events.filter((e) => {
      if (e.name !== params.name) return false;
      if (e.id <= params.afterId) return false;
      if (params.minCreatedAt && e.createdAt.getTime() < params.minCreatedAt.getTime()) return false;
      if (params.repo && e.repo !== params.repo) return false;
      if (params.prNumber !== undefined && e.prNumber !== params.prNumber) return false;
      if (params.conclusion && e.conclusion !== params.conclusion) return false;
      if (params.checkName && (!e.checkName || e.checkName.toLowerCase() !== params.checkName.toLowerCase())) {
        return false;
      }
      return true;
    });
    if (params.order === 'desc') {
      return matched.slice(-params.limit).reverse();
    }
    return matched.slice(0, params.limit);
  }

  async hasSkippedEventsBeforeFloor(params: {
    name: McpEventName;
    afterId: number;
    minCreatedAt: Date;
  }): Promise<boolean> {
    return this.events.some(
      (e) => e.name === params.name && e.id > params.afterId && e.createdAt.getTime() < params.minCreatedAt.getTime(),
    );
  }

  async getSubscriptionByKeyHash(keyHash: string): Promise<McpEventSubscription | null> {
    const sub = this.subscriptions.get(keyHash);
    return sub ? { ...sub } : null;
  }

  async countActiveSubscriptions(principal: string): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const sub of this.subscriptions.values()) {
      if (sub.principal === principal && sub.expiresAt.getTime() > now) count += 1;
    }
    return count;
  }

  async upsertSubscription(input: {
    subscriptionKeyHash: string;
    subscriptionId: string;
    principal: string;
    oauthTokenFamilyId: string | null;
    eventName: McpEventName;
    arguments: Record<string, unknown>;
    callbackUrl: string;
    secret: string;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
    expiresAt: Date;
    lastCursorId: number;
    maxActivePerPrincipal?: number;
  }): Promise<McpEventSubscription> {
    const existing = this.subscriptions.get(input.subscriptionKeyHash);
    const now = new Date();
    const isExistingActive = Boolean(existing && existing.expiresAt.getTime() > now.getTime());
    if (!isExistingActive && input.maxActivePerPrincipal !== undefined) {
      let activeCount = 0;
      for (const sub of this.subscriptions.values()) {
        if (sub.principal === input.principal && sub.expiresAt.getTime() > now.getTime()) {
          activeCount += 1;
        }
      }
      if (activeCount >= input.maxActivePerPrincipal) {
        throw new McpEventSubscriptionQuotaExceededError(input.maxActivePerPrincipal);
      }
    }
    const record: McpEventSubscription = {
      subscriptionKeyHash: input.subscriptionKeyHash,
      subscriptionId: input.subscriptionId,
      principal: input.principal,
      oauthTokenFamilyId: input.oauthTokenFamilyId,
      eventName: input.eventName,
      arguments: { ...input.arguments },
      callbackUrl: input.callbackUrl,
      secret: input.secret,
      previousSecret: input.previousSecret,
      previousSecretExpiresAt: input.previousSecretExpiresAt,
      expiresAt: input.expiresAt,
      lastCursorId: isExistingActive
        ? Math.max(existing!.lastCursorId, input.lastCursorId)
        : input.lastCursorId,
      active: true,
      consecutiveFailures: 0,
      lastDeliveryAt: existing?.lastDeliveryAt ?? null,
      lastError: null,
      failedSince: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscriptions.set(input.subscriptionKeyHash, record);
    return { ...record };
  }

  async advanceSubscriptionCursor(keyHash: string, minCursorId: number): Promise<void> {
    const sub = this.subscriptions.get(keyHash);
    if (!sub) return;
    if (minCursorId > sub.lastCursorId) {
      sub.lastCursorId = minCursorId;
      sub.updatedAt = new Date();
    }
  }

  async deleteSubscriptionByKeyHash(keyHash: string): Promise<boolean> {
    return this.subscriptions.delete(keyHash);
  }

  async listActiveSubscriptions(eventName: McpEventName): Promise<McpEventSubscription[]> {
    const now = Date.now();
    const out: McpEventSubscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.eventName === eventName && sub.active && sub.expiresAt.getTime() > now) {
        out.push({ ...sub });
      }
    }
    return out;
  }

  async updateDeliveryStatus(params: {
    subscriptionKeyHash: string;
    active: boolean;
    consecutiveFailures: number;
    lastDeliveryAt?: Date | null;
    lastError: WebhookErrorCategory | null;
    failedSince?: Date | null;
    lastCursorId?: number;
  }): Promise<void> {
    const sub = this.subscriptions.get(params.subscriptionKeyHash);
    if (!sub) return;
    sub.active = params.active;
    sub.consecutiveFailures = params.consecutiveFailures;
    if (params.lastDeliveryAt) sub.lastDeliveryAt = params.lastDeliveryAt;
    sub.lastError = params.lastError;
    sub.failedSince = params.failedSince ?? null;
    if (params.lastCursorId !== undefined) {
      sub.lastCursorId = Math.max(sub.lastCursorId, params.lastCursorId);
    }
    sub.updatedAt = new Date();
  }

  async isEndpointVerified(principal: string, callbackUrl: string): Promise<boolean> {
    const exp = this.verifiedEndpoints.get(`${principal}\0${callbackUrl}`);
    return Boolean(exp && exp.getTime() > Date.now());
  }

  async markEndpointVerified(principal: string, callbackUrl: string, expiresAt: Date): Promise<void> {
    this.verifiedEndpoints.set(`${principal}\0${callbackUrl}`, expiresAt);
  }

  async isPrincipalAuthorized(sub: McpEventSubscription): Promise<boolean> {
    if (this.revokedPrincipals.has(sub.principal)) return false;
    if (sub.oauthTokenFamilyId && this.revokedFamilies.has(sub.oauthTokenFamilyId)) return false;
    return true;
  }
}

function getSigningSecrets(sub: McpEventSubscription): string[] {
  const secrets = [sub.secret];
  if (
    sub.previousSecret &&
    sub.previousSecretExpiresAt &&
    sub.previousSecretExpiresAt.getTime() > Date.now()
  ) {
    secrets.push(sub.previousSecret);
  }
  return secrets;
}

export async function verifyWebhookEndpoint(params: {
  url: URL;
  subscriptionId: string;
  secret: string;
  deliverWebhook: WebhookDeliverFn;
}): Promise<void> {
  const challenge = randomBytes(16).toString('hex');
  const webhookId = `msg_verification_${randomBytes(12).toString('hex')}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ type: 'verification', challenge });
  const signature = signStandardWebhook(webhookId, timestampSec, rawBody, [params.secret]);

  const res = await params.deliverWebhook({
    url: params.url,
    rawBody,
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestampSec),
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': params.subscriptionId,
    },
  });

  if (!res.ok) {
    const reason = res.errorCategory || 'challenge_failed';
    throw new ProtocolError(
      EventsErrorCode.CallbackEndpointError,
      `Webhook endpoint verification failed (${reason}).`,
      { reason },
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(res.bodyText || '');
  } catch {
    throw new ProtocolError(
      EventsErrorCode.CallbackEndpointError,
      'Webhook endpoint verification failed (challenge_failed).',
      { reason: 'challenge_failed' },
    );
  }

  const echoed =
    parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? (parsedBody as Record<string, unknown>).challenge
      : null;

  if (typeof echoed !== 'string' || !timingSafeEqualStrings(echoed, challenge)) {
    throw new ProtocolError(
      EventsErrorCode.CallbackEndpointError,
      'Webhook endpoint verification failed (challenge_failed).',
      { reason: 'challenge_failed' },
    );
  }
}

async function sendTerminatedEnvelope(
  sub: McpEventSubscription,
  deliverWebhook: WebhookDeliverFn,
): Promise<void> {
  const url = isValidWebhookCallbackUrl(sub.callbackUrl);
  if (!url) return;
  const webhookId = `msg_terminated_${randomBytes(12).toString('hex')}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    type: 'terminated',
    error: {
      code: EventsErrorCode.Forbidden,
      message: 'Forbidden',
      data: { reason: 'Access revoked' },
    },
  });
  const signature = signStandardWebhook(webhookId, timestampSec, rawBody, getSigningSecrets(sub));
  await deliverWebhook({
    url,
    rawBody,
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestampSec),
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': sub.subscriptionId,
    },
  }).catch(() => {});
}

const subscriptionDeliveryChains = new Map<string, Promise<void>>();

function enqueueSubscriptionDelivery<T>(
  subscriptionKeyHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = subscriptionDeliveryChains.get(subscriptionKeyHash) ?? Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const nextChain = prev.then(() => done);
  subscriptionDeliveryChains.set(subscriptionKeyHash, nextChain);

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      resolveDone();
      if (subscriptionDeliveryChains.get(subscriptionKeyHash) === nextChain) {
        subscriptionDeliveryChains.delete(subscriptionKeyHash);
      }
    }
  });
}

async function hasEarlierUnacknowledgedMatchingEvent(
  store: McpEventsStore,
  sub: McpEventSubscription,
  eventId: number,
): Promise<boolean> {
  if (eventId <= sub.lastCursorId) {
    return false;
  }
  const args = sub.arguments || {};
  const earliest = await store.queryEvents({
    name: sub.eventName,
    afterId: sub.lastCursorId,
    repo: typeof args.repo === 'string' ? args.repo : undefined,
    prNumber: typeof args.prNumber === 'number' ? args.prNumber : undefined,
    conclusion: typeof args.conclusion === 'string' ? args.conclusion : undefined,
    checkName: typeof args.checkName === 'string' ? args.checkName : undefined,
    limit: 1,
    order: 'asc',
  });
  return earliest.length > 0 && earliest[0].id < eventId;
}

export async function deliverEventToSubscription(params: {
  store: McpEventsStore;
  subscription: McpEventSubscription;
  event: McpEventRecord;
  deliverWebhook?: WebhookDeliverFn;
  retryDelaysMs?: number[];
}): Promise<{
  delivered: boolean;
  discarded?: boolean;
  terminated?: boolean;
  stopped?: boolean;
  lastError?: WebhookErrorCategory;
}> {
  const {
    store,
    subscription: sub,
    event,
    deliverWebhook = (p) => deliverWebhookPinnedHttps(p),
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  } = params;

  const url = isValidWebhookCallbackUrl(sub.callbackUrl);
  if (!url) {
    await store.updateDeliveryStatus({
      subscriptionKeyHash: sub.subscriptionKeyHash,
      active: false,
      consecutiveFailures: sub.consecutiveFailures + 1,
      lastError: 'connection_refused',
      failedSince: sub.failedSince ?? new Date(),
    });
    return { delivered: false, lastError: 'connection_refused' };
  }

  const webhookId = `msg_${randomBytes(16).toString('hex')}`;
  const rawBody = JSON.stringify({
    eventId: event.eventId,
    name: event.name,
    timestamp: event.createdAt.toISOString(),
    data: event.data,
    cursor: encodeEventCursor(event.id),
  });

  let currentSub = sub;
  let lastError: WebhookErrorCategory = 'http_5xx';

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      const delay = retryDelaysMs[attempt - 1];
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Re-fetch latest subscription state before EVERY attempt including attempt 0
    // (handles unsubscribe, expiry, suspension, failure state updates, or secret rotation).
    const latestSub = await store.getSubscriptionByKeyHash(sub.subscriptionKeyHash);
    if (!latestSub || !latestSub.active || latestSub.expiresAt.getTime() <= Date.now()) {
      return { delivered: false, stopped: true };
    }
    currentSub = latestSub;

    // Re-verify principal authorization immediately before every delivery attempt (including retries)
    const authorized = await store.isPrincipalAuthorized(currentSub);
    if (!authorized) {
      await store.deleteSubscriptionByKeyHash(currentSub.subscriptionKeyHash);
      await sendTerminatedEnvelope(currentSub, deliverWebhook);
      return { delivered: false, terminated: true };
    }

    const timestampSec = Math.floor(Date.now() / 1000);
    const signature = signStandardWebhook(webhookId, timestampSec, rawBody, getSigningSecrets(currentSub));
    let res: WebhookPostResponse;
    try {
      res = await deliverWebhook({
        url,
        rawBody,
        headers: {
          'webhook-id': webhookId,
          'webhook-timestamp': String(timestampSec),
          'webhook-signature': signature,
          'X-MCP-Subscription-Id': currentSub.subscriptionId,
        },
      });
    } catch {
      res = { ok: false, errorCategory: 'connection_refused' };
    }

    if (res.ok) {
      // Only advance the recovery watermark and clear failure state if there is no unresolved
      // prior delivery failure and no earlier matching event still unacknowledged.
      const hasUnresolvedFailure =
        currentSub.consecutiveFailures > 0 || currentSub.failedSince !== null;
      const hasEarlierGap =
        !hasUnresolvedFailure &&
        (await hasEarlierUnacknowledgedMatchingEvent(store, currentSub, event.id));
      if (!hasUnresolvedFailure && !hasEarlierGap) {
        await store.updateDeliveryStatus({
          subscriptionKeyHash: currentSub.subscriptionKeyHash,
          active: true,
          consecutiveFailures: 0,
          lastDeliveryAt: new Date(),
          lastError: null,
          failedSince: null,
          lastCursorId: event.id,
        });
      } else {
        // Keep the recovery watermark and failedSince/lastError pinned behind the earlier
        // unacknowledged event, but reset the consecutive failure streak since this delivery succeeded.
        await store.updateDeliveryStatus({
          subscriptionKeyHash: currentSub.subscriptionKeyHash,
          active: currentSub.active,
          consecutiveFailures: 0,
          lastDeliveryAt: new Date(),
          lastError: currentSub.lastError,
          failedSince: currentSub.failedSince,
        });
      }
      return { delivered: true };
    }

    lastError = res.errorCategory || 'http_5xx';
    // Per SEP-3415 §Webhook event delivery: 410 Gone and 413 Payload Too Large are non-retryable
    // per-delivery discards that do not suspend the subscription itself.
    if (res.status === 410 || res.status === 413) {
      const hasUnresolvedFailure =
        currentSub.consecutiveFailures > 0 || currentSub.failedSince !== null;
      const hasEarlierGap =
        !hasUnresolvedFailure &&
        (await hasEarlierUnacknowledgedMatchingEvent(store, currentSub, event.id));
      if (!hasUnresolvedFailure && !hasEarlierGap) {
        await store.updateDeliveryStatus({
          subscriptionKeyHash: currentSub.subscriptionKeyHash,
          active: true,
          consecutiveFailures: 0,
          lastError: null,
          failedSince: null,
          lastCursorId: event.id,
        });
      } else {
        await store.updateDeliveryStatus({
          subscriptionKeyHash: currentSub.subscriptionKeyHash,
          active: currentSub.active,
          consecutiveFailures: 0,
          lastError: currentSub.lastError,
          failedSince: currentSub.failedSince,
        });
      }
      return { delivered: false, discarded: true, lastError: 'http_4xx' };
    }
  }

  const nextFailures = currentSub.consecutiveFailures + 1;
  const stillActive = nextFailures < MAX_CONSECUTIVE_FAILURES_BEFORE_SUSPEND;
  await store.updateDeliveryStatus({
    subscriptionKeyHash: currentSub.subscriptionKeyHash,
    active: stillActive,
    consecutiveFailures: nextFailures,
    lastError,
    failedSince: currentSub.failedSince ?? new Date(),
  });
  return { delivered: false, lastError };
}

export async function publishMcpEvent(
  store: McpEventsStore,
  input: {
    eventId: string;
    name: McpEventName;
    repo?: string | null;
    prNumber?: number | null;
    conclusion?: string | null;
    checkName?: string | null;
    data: Record<string, unknown>;
  },
  options?: {
    deliverWebhook?: WebhookDeliverFn;
    retryDelaysMs?: number[];
    awaitDeliveries?: boolean;
  },
): Promise<McpEventRecord> {
  const record = await store.insertEvent(input);
  const subs = await store.listActiveSubscriptions(record.name);
  const matching = subs.filter((sub) => eventMatchesSubscriptionArgs(record, sub.arguments));

  if (matching.length > 0) {
    const dispatch = Promise.all(
      matching.map((sub) =>
        enqueueSubscriptionDelivery(sub.subscriptionKeyHash, () =>
          deliverEventToSubscription({
            store,
            subscription: sub,
            event: record,
            deliverWebhook: options?.deliverWebhook,
            retryDelaysMs: options?.retryDelaysMs,
          }),
        ).catch((err) => {
          console.error(`[MCP Events] Webhook delivery failed for ${sub.subscriptionId}:`, err);
        }),
      ),
    );
    if (options?.awaitDeliveries) {
      await dispatch;
    } else {
      void dispatch;
    }
  }

  return record;
}

const EventsListParamsSchema = z
  .object({
    cursor: z.string().optional(),
  })
  .optional();

const EventsPollParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  maxEvents: z.number().int().min(1).max(MAX_POLL_EVENTS).optional(),
});

const EventsStreamParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  heartbeatMs: z.number().int().positive().optional(),
});

const EventsSubscribeParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({
    mode: z.string().optional(),
    url: z.string().min(1),
    secret: z.string().min(1),
  }),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});

const EventsUnsubscribeParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({
    url: z.string().min(1),
  }),
});

export interface McpEventsExtensionOptions {
  store: McpEventsStore;
  principal: string;
  oauthTokenFamilyId?: string | null;
  canRead?: boolean;
  deliverWebhook?: WebhookDeliverFn;
  retryDelaysMs?: number[];
}

function buildDeliveryStatus(sub: McpEventSubscription): McpEventDeliveryStatus {
  const status: McpEventDeliveryStatus = {
    active: sub.active,
    lastDeliveryAt: sub.lastDeliveryAt ? sub.lastDeliveryAt.toISOString() : null,
    lastError: sub.lastError,
  };
  if (sub.failedSince) {
    status.failedSince = sub.failedSince.toISOString();
  }
  return status;
}

function computeGrantedTtlMs(suggestedTtlMs: number | null | undefined): number {
  if (suggestedTtlMs === undefined) {
    return DEFAULT_WEBHOOK_TTL_MS;
  }
  if (suggestedTtlMs === null) {
    // Per SEP-3415 §Subscription TTL, a server unwilling to grant infinite retention
    // returns a finite refreshBefore grant (7 days max here).
    return MAX_WEBHOOK_TTL_MS;
  }
  if (suggestedTtlMs < MIN_WEBHOOK_TTL_MS) {
    return MIN_WEBHOOK_TTL_MS;
  }
  return Math.min(suggestedTtlMs, MAX_WEBHOOK_TTL_MS);
}

export function registerMcpEventsExtension(server: McpServer, options: McpEventsExtensionOptions): void {
  const {
    store,
    principal,
    oauthTokenFamilyId = null,
    canRead = true,
    deliverWebhook = (p) => deliverWebhookPinnedHttps(p),
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  } = options;

  server.server.registerCapabilities({
    extensions: {
      [EVENTS_EXTENSION_ID]: {
        listChanged: false,
      },
    },
  });

  function assertReadPermission(): void {
    if (!canRead) {
      throw new ProtocolError(
        EventsErrorCode.Forbidden,
        'Insufficient OAuth scope: "mcp:read" is required to use MCP Events.',
        { reason: 'missing_scope', requiredScope: 'mcp:read' },
      );
    }
  }

  function assertAuthenticatedPrincipal(): void {
    assertReadPermission();
    if (!principal || principal === 'anonymous') {
      throw new ProtocolError(
        EventsErrorCode.Forbidden,
        'Webhook subscriptions require an authenticated principal.',
        { reason: 'authentication_required' },
      );
    }
  }

  // 1. events/list
  server.server.setRequestHandler('events/list', { params: EventsListParamsSchema }, async () => {
    assertReadPermission();
    return {
      resultType: 'complete',
      events: MCP_EVENT_DESCRIPTORS.map((d) => ({
        name: d.name,
        description: d.description,
        delivery: [...d.delivery],
        inputSchema: d.inputSchema,
        payloadSchema: d.payloadSchema,
      })),
    };
  });

  // 2. events/poll
  server.server.setRequestHandler('events/poll', { params: EventsPollParamsSchema }, async (params) => {
    assertReadPermission();
    if (!isKnownMcpEventName(params.name)) {
      throw new ProtocolError(EventsErrorCode.NotFound, `Unknown event type: ${params.name}`, {
        kind: 'event',
      });
    }
    const validatedArgs = validateEventArguments(params.name, params.arguments);
    const cursorSeq = decodeEventCursor(params.cursor);
    const bounds = await store.getStreamBounds();

    // cursor === null (or absent) means "start from now": return no events and a fresh cursor
    if (cursorSeq === null) {
      return {
        resultType: 'complete',
        events: [],
        cursor: encodeEventCursor(bounds.latestId),
        truncated: false,
        hasMore: false,
        nextPollMs: DEFAULT_POLL_INTERVAL_MS,
      };
    }

    let truncated = false;
    let effectiveAfterId = cursorSeq;
    if (bounds.oldestId !== null && cursorSeq > 0 && cursorSeq < bounds.oldestId - 1) {
      truncated = true;
      effectiveAfterId = bounds.oldestId - 1;
    }

    let minCreatedAt: Date | null = null;
    if (params.maxAgeMs !== undefined) {
      minCreatedAt = new Date(Date.now() - params.maxAgeMs);
      if (
        !truncated &&
        (await store.hasSkippedEventsBeforeFloor({
          name: params.name,
          afterId: effectiveAfterId,
          minCreatedAt,
        }))
      ) {
        truncated = true;
      }
    }

    const maxEvents = Math.min(MAX_POLL_EVENTS, Math.max(1, params.maxEvents ?? DEFAULT_MAX_EVENTS));
    const rows = await store.queryEvents({
      name: params.name,
      afterId: effectiveAfterId,
      minCreatedAt,
      repo: typeof validatedArgs.repo === 'string' ? validatedArgs.repo : undefined,
      prNumber: typeof validatedArgs.prNumber === 'number' ? validatedArgs.prNumber : undefined,
      conclusion: typeof validatedArgs.conclusion === 'string' ? validatedArgs.conclusion : undefined,
      checkName: typeof validatedArgs.checkName === 'string' ? validatedArgs.checkName : undefined,
      limit: maxEvents + 1,
    });

    const hasMore = rows.length > maxEvents;
    const batch = hasMore ? rows.slice(0, maxEvents) : rows;
    const nextCursorId =
      batch.length > 0 ? batch[batch.length - 1].id : Math.max(effectiveAfterId, bounds.latestId);

    return {
      resultType: 'complete',
      events: batch.map((e) => ({
        eventId: e.eventId,
        name: e.name,
        timestamp: e.createdAt.toISOString(),
        data: e.data,
      })),
      cursor: encodeEventCursor(nextCursorId),
      truncated,
      hasMore,
      nextPollMs: DEFAULT_POLL_INTERVAL_MS,
    };
  });

  // 3. events/stream (explicitly unsupported — Poll and Webhook are supported)
  server.server.setRequestHandler('events/stream', { params: EventsStreamParamsSchema }, async () => {
    assertReadPermission();
    throw new ProtocolError(
      EventsErrorCode.Unsupported,
      'Push delivery (events/stream) is not supported; use "poll" or "webhook" delivery.',
      { feature: 'deliveryMode', value: 'push' },
    );
  });

  // 4. events/subscribe (Webhook mode)
  server.server.setRequestHandler('events/subscribe', { params: EventsSubscribeParamsSchema }, async (params) => {
    assertAuthenticatedPrincipal();
    if (!isKnownMcpEventName(params.name)) {
      throw new ProtocolError(EventsErrorCode.NotFound, `Unknown event type: ${params.name}`, {
        kind: 'event',
      });
    }
    if (params.delivery.mode && params.delivery.mode !== 'webhook') {
      throw new ProtocolError(
        EventsErrorCode.Unsupported,
        `Unsupported delivery mode for events/subscribe: ${params.delivery.mode}`,
        { feature: 'deliveryMode', value: params.delivery.mode },
      );
    }

    const validatedArgs = validateEventArguments(params.name, params.arguments);
    const parsedUrl = isValidWebhookCallbackUrl(params.delivery.url);
    if (!parsedUrl) {
      throw new ProtocolError(
        EventsErrorCode.InvalidParams,
        'delivery.url must be a valid public https:// URL without credentials or fragments.',
      );
    }
    if (!parseWebhookSecretBytes(params.delivery.secret)) {
      throw new ProtocolError(
        EventsErrorCode.InvalidParams,
        'delivery.secret must be a Standard Webhooks secret ("whsec_" followed by base64 of 24 to 64 bytes).',
      );
    }

    const cursorSeq = decodeEventCursor(params.cursor);
    const { subscriptionKeyHash, subscriptionId } = deriveSubscriptionIdentity(
      principal,
      parsedUrl.toString(),
      params.name,
      validatedArgs,
    );

    const existingBeforeVerify = await store.getSubscriptionByKeyHash(subscriptionKeyHash);
    const isRefreshBeforeVerify = Boolean(
      existingBeforeVerify && existingBeforeVerify.expiresAt.getTime() > Date.now(),
    );

    // Fast pre-check before outbound endpoint verification; the authoritative quota check
    // runs atomically inside store.upsertSubscription under a per-principal lock.
    if (!isRefreshBeforeVerify) {
      const activeCount = await store.countActiveSubscriptions(principal);
      if (activeCount >= MAX_SUBSCRIPTIONS_PER_PRINCIPAL) {
        throw new ProtocolError(
          EventsErrorCode.ResourceExhausted,
          `Active webhook subscription quota exceeded (max ${MAX_SUBSCRIPTIONS_PER_PRINCIPAL} per principal).`,
          { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS_PER_PRINCIPAL },
        );
      }
    }

    // Endpoint verification cached per (principal, url) per SEP-3415 §Endpoint verification
    const alreadyVerified = await store.isEndpointVerified(principal, parsedUrl.toString());
    if (!alreadyVerified) {
      await verifyWebhookEndpoint({
        url: parsedUrl,
        subscriptionId,
        secret: params.delivery.secret,
        deliverWebhook,
      });
      await store.markEndpointVerified(
        principal,
        parsedUrl.toString(),
        new Date(Date.now() + VERIFICATION_CACHE_TTL_MS),
      );
    }

    // Re-read current subscription state after verification so refresh status, secret rotation,
    // and replay starting position reflect the latest persisted state.
    const existing = await store.getSubscriptionByKeyHash(subscriptionKeyHash);
    const isRefresh = Boolean(existing && existing.expiresAt.getTime() > Date.now());
    const previousDeliveryStatus = existing && isRefresh ? buildDeliveryStatus(existing) : undefined;

    const grantedTtlMs = computeGrantedTtlMs(params.ttlMs);
    const expiresAt = new Date(Date.now() + grantedTtlMs);

    // Determine whether we should recover/replay matching events from a starting position:
    // - On refresh: start from the subscription's last acknowledged watermark so suspended or
    //   temporarily failing subscriptions recover missed matching events instead of skipping them.
    // - On fresh subscribe with non-null cursor: start from the client's supplied cursor.
    const replayFromSeq =
      isRefresh && existing ? existing.lastCursorId : cursorSeq !== null ? cursorSeq : null;

    const initialWatermarkId =
      replayFromSeq !== null ? replayFromSeq : (await store.getStreamBounds()).latestId;

    // Secret rotation: keep old secret for a 5-minute dual-sign grace window
    const secretChanged = Boolean(existing && existing.secret !== params.delivery.secret);
    const previousSecret = secretChanged ? existing!.secret : (existing?.previousSecret ?? null);
    const previousSecretExpiresAt = secretChanged
      ? new Date(Date.now() + SECRET_ROTATION_GRACE_MS)
      : (existing?.previousSecretExpiresAt ?? null);

    // Install/update the subscription BEFORE querying the catch-up window so:
    // 1. Per-principal quota is enforced atomically with insertion across concurrent callers.
    // 2. Any event published concurrently either appears in the subsequent replay query or sees
    //    the already-installed subscription in publishMcpEvent (zero gap between replay and live).
    let saved: McpEventSubscription;
    try {
      saved = await store.upsertSubscription({
        subscriptionKeyHash,
        subscriptionId,
        principal,
        oauthTokenFamilyId,
        eventName: params.name,
        arguments: validatedArgs,
        callbackUrl: parsedUrl.toString(),
        secret: params.delivery.secret,
        previousSecret,
        previousSecretExpiresAt,
        expiresAt,
        lastCursorId: initialWatermarkId,
        maxActivePerPrincipal: MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
      });
    } catch (err) {
      if (
        err instanceof McpEventSubscriptionQuotaExceededError ||
        (err instanceof Error && err.name === 'McpEventSubscriptionQuotaExceededError')
      ) {
        throw new ProtocolError(
          EventsErrorCode.ResourceExhausted,
          `Active webhook subscription quota exceeded (max ${MAX_SUBSCRIPTIONS_PER_PRINCIPAL} per principal).`,
          { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS_PER_PRINCIPAL },
        );
      }
      throw err;
    }

    let truncated = false;
    let replayEvents: McpEventRecord[] = [];
    let watermarkId = saved.lastCursorId;

    // Always run post-install catch-up from saved.lastCursorId — even for fresh cursorless
    // subscriptions — so an event published between the pre-upsert bounds read and subscription
    // installation cannot be missed or stall subsequent watermark advancement.
    const bounds = await store.getStreamBounds();
    let effectiveAfterId = saved.lastCursorId;
    if (
      replayFromSeq !== null &&
      bounds.oldestId !== null &&
      effectiveAfterId > 0 &&
      effectiveAfterId < bounds.oldestId - 1
    ) {
      truncated = true;
      effectiveAfterId = bounds.oldestId - 1;
    }
    let minCreatedAt: Date | null = null;
    if (replayFromSeq !== null && params.maxAgeMs !== undefined) {
      minCreatedAt = new Date(Date.now() - params.maxAgeMs);
      if (
        !truncated &&
        (await store.hasSkippedEventsBeforeFloor({
          name: params.name,
          afterId: effectiveAfterId,
          minCreatedAt,
        }))
      ) {
        truncated = true;
      }
    }
    // Query the NEWEST permitted window (DESC) AFTER the subscription is installed so no event
    // can fall between catch-up replay and live delivery.
    const newestDesc = await store.queryEvents({
      name: params.name,
      afterId: effectiveAfterId,
      minCreatedAt,
      repo: typeof validatedArgs.repo === 'string' ? validatedArgs.repo : undefined,
      prNumber: typeof validatedArgs.prNumber === 'number' ? validatedArgs.prNumber : undefined,
      conclusion: typeof validatedArgs.conclusion === 'string' ? validatedArgs.conclusion : undefined,
      checkName: typeof validatedArgs.checkName === 'string' ? validatedArgs.checkName : undefined,
      limit: DEFAULT_MAX_EVENTS + 1,
      order: 'desc',
    });
    if (newestDesc.length > DEFAULT_MAX_EVENTS) {
      truncated = true;
      replayEvents = newestDesc.slice(0, DEFAULT_MAX_EVENTS).reverse();
    } else {
      replayEvents = newestDesc.reverse();
    }
    // Preserve safe-to-persist watermark:
    // - If matching events are pending delivery, do not advance past the first unacknowledged event.
    // - If no matching events exist in (effectiveAfterId, bounds.latestId], safely advance during quiet periods.
    if (replayEvents.length > 0) {
      watermarkId = truncated ? Math.max(effectiveAfterId, replayEvents[0].id - 1) : effectiveAfterId;
    } else {
      watermarkId = Math.max(effectiveAfterId, bounds.latestId);
    }
    if (watermarkId > saved.lastCursorId) {
      await store.advanceSubscriptionCursor(saved.subscriptionKeyHash, watermarkId);
    }

    if (replayEvents.length > 0) {
      void enqueueSubscriptionDelivery(saved.subscriptionKeyHash, async () => {
        for (const ev of replayEvents) {
          const latestSub = await store.getSubscriptionByKeyHash(saved.subscriptionKeyHash);
          if (!latestSub || !latestSub.active || latestSub.expiresAt.getTime() <= Date.now()) {
            break;
          }
          if (ev.id <= latestSub.lastCursorId) {
            continue;
          }
          const outcome = await deliverEventToSubscription({
            store,
            subscription: latestSub,
            event: ev,
            deliverWebhook,
            retryDelaysMs,
          }).catch((err) => {
            console.error(`[MCP Events] Replay delivery failed for ${saved.subscriptionId}:`, err);
            return null;
          });
          // Only continue replay if the event was delivered OR explicitly discarded (410/413).
          // Any retry-exhausted failure, transport error, termination, or unsubscribe/expiry stops
          // replay so the watermark remains strictly before the unresolved event.
          if (!outcome || outcome.terminated || outcome.stopped || (!outcome.delivered && !outcome.discarded)) {
            break;
          }
        }
      }).catch((err) => {
        console.error(`[MCP Events] Replay task failed for ${saved.subscriptionId}:`, err);
      });
    }

    return {
      resultType: 'complete',
      id: saved.subscriptionId,
      refreshBefore: saved.expiresAt.toISOString(),
      cursor: encodeEventCursor(watermarkId),
      truncated,
      ...(previousDeliveryStatus ? { deliveryStatus: previousDeliveryStatus } : {}),
    };
  });

  // 5. events/unsubscribe (Webhook mode)
  server.server.setRequestHandler(
    'events/unsubscribe',
    { params: EventsUnsubscribeParamsSchema },
    async (params) => {
      assertAuthenticatedPrincipal();
      if (!isKnownMcpEventName(params.name)) {
        throw new ProtocolError(EventsErrorCode.NotFound, `Unknown event type: ${params.name}`, {
          kind: 'event',
        });
      }
      const validatedArgs = validateEventArguments(params.name, params.arguments);
      const parsedUrl = isValidWebhookCallbackUrl(params.delivery.url);
      if (!parsedUrl) {
        throw new ProtocolError(
          EventsErrorCode.InvalidParams,
          'delivery.url must be a valid public https:// URL.',
        );
      }
      const { subscriptionKeyHash } = deriveSubscriptionIdentity(
        principal,
        parsedUrl.toString(),
        params.name,
        validatedArgs,
      );
      const deleted = await store.deleteSubscriptionByKeyHash(subscriptionKeyHash);
      if (!deleted) {
        throw new ProtocolError(
          EventsErrorCode.NotFound,
          'No active webhook subscription matches this key.',
          { kind: 'subscription' },
        );
      }
      return {
        resultType: 'complete',
      };
    },
  );
}

const EVENTS_NAMED_METHODS = new Set([
  'events/poll',
  'events/stream',
  'events/subscribe',
  'events/unsubscribe',
]);

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

function decodeMcpHeaderValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith(BASE64_SENTINEL_PREFIX) && trimmed.endsWith(BASE64_SENTINEL_SUFFIX))) {
    return trimmed;
  }
  const b64 = trimmed.slice(BASE64_SENTINEL_PREFIX.length, trimmed.length - BASE64_SENTINEL_SUFFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Validates Streamable HTTP routing headers for MCP Events per SEP-3415 §Streamable HTTP:
 * `events/poll`, `events/stream`, `events/subscribe`, and `events/unsubscribe` MUST carry
 * `Mcp-Name` matching `params.name` on modern `2026-07-28` requests (HTTP 400 / -32020 on mismatch).
 */
export async function validateMcpEventsRoutingHeaders(request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const methodHeader = request.headers.get('mcp-method')?.trim();
  if (!methodHeader || !EVENTS_NAMED_METHODS.has(methodHeader)) return null;

  let parsed: { id?: string | number | null; method?: unknown; params?: { name?: unknown } };
  try {
    parsed = (await request.clone().json()) as typeof parsed;
  } catch {
    return null;
  }

  if (typeof parsed?.method !== 'string' || !EVENTS_NAMED_METHODS.has(parsed.method)) return null;
  const bodyName = typeof parsed.params?.name === 'string' ? parsed.params.name : null;
  if (!bodyName) return null;

  const rawHeader = request.headers.get('mcp-name');
  if (rawHeader === null) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: {
          code: EventsErrorCode.HeaderMismatch,
          message: `Missing required Mcp-Name header for ${parsed.method} (expected "${bodyName}").`,
        },
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      },
    );
  }

  const decoded = decodeMcpHeaderValue(rawHeader);
  if (decoded === null || decoded !== bodyName) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: {
          code: EventsErrorCode.HeaderMismatch,
          message: `Mcp-Name header "${rawHeader}" does not match params.name "${bodyName}".`,
        },
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      },
    );
  }

  return null;
}

export interface PrReviewCheckCompletedEventInput {
  checkId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  checkName: string;
  checkIdentity?: string | null;
  conclusion: ReviewConclusion;
  executionId?: string;
  baseUrl: string;
}

export interface PrReviewCompletedEventInput {
  repo: string;
  prNumber: number;
  headSha: string;
  checks: Array<{
    checkId: number;
    checkName: string;
    checkIdentity?: string | null;
    conclusion: ReviewConclusion;
  }>;
  expectedChecksCount?: number;
  incompleteReason?: 'failure' | 'cancelled';
  executionId?: string;
  baseUrl: string;
}

export interface PrReviewApprovalRequiredEventInput {
  checkId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  checkName: string;
  approvalId?: string;
  segment?: number;
  executionGeneration?: number;
  promptId?: string;
  baseUrl: string;
}

export function buildPrReviewCheckCompletedPayload(input: PrReviewCheckCompletedEventInput) {
  const base = input.baseUrl.replace(/\/+$/, '');
  const eventId = input.executionId
    ? `jci_chk_${input.checkId}_${createHash('sha256').update(input.executionId).digest('hex').slice(0, 12)}`
    : `jci_chk_${input.checkId}`;
  return {
    eventId,
    name: 'pr_review.check_completed' as const,
    repo: input.repo,
    prNumber: input.prNumber,
    conclusion: input.conclusion,
    checkName: input.checkName,
    data: {
      checkId: input.checkId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      checkName: input.checkName,
      checkIdentity: input.checkIdentity ?? null,
      conclusion: input.conclusion,
      detailsUrl: `${base}/checks/${input.checkId}`,
      prUrl: `https://github.com/${input.repo}/pull/${input.prNumber}`,
    },
  };
}

export function buildPrReviewCompletedPayload(input: PrReviewCompletedEventInput) {
  const base = input.baseUrl.replace(/\/+$/, '');
  const expectedChecksCount = Math.max(input.checks.length, input.expectedChecksCount ?? input.checks.length);
  const incompleteChecksCount = Math.max(0, expectedChecksCount - input.checks.length);
  const incomplete = incompleteChecksCount > 0;
  const failedCount = input.checks.filter((c) => c.conclusion === 'failure').length;
  const neutralCount = input.checks.filter((c) => c.conclusion === 'neutral').length;
  let overallConclusion: ReviewConclusion;
  if (failedCount > 0 || (incomplete && input.incompleteReason !== 'cancelled')) {
    overallConclusion = 'failure';
  } else if (incomplete || neutralCount > 0 || input.checks.length === 0) {
    overallConclusion = 'neutral';
  } else {
    overallConclusion = 'success';
  }
  const sortedCheckIds = input.checks
    .map((c) => c.checkId)
    .sort((a, b) => a - b)
    .join(',');
  const runFingerprint = createHash('sha256')
    .update(
      `${input.repo}#${input.prNumber}@${input.headSha}:${sortedCheckIds}:${expectedChecksCount}:${incompleteChecksCount}:${overallConclusion}:${input.executionId ?? ''}`,
    )
    .digest('hex')
    .slice(0, 16);

  return {
    eventId: `jci_prrev_${runFingerprint}`,
    name: 'pr_review.completed' as const,
    repo: input.repo,
    prNumber: input.prNumber,
    conclusion: overallConclusion,
    checkName: null,
    data: {
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      overallConclusion,
      checksCount: input.checks.length,
      expectedChecksCount,
      incompleteChecksCount,
      incomplete,
      failedCount,
      checks: input.checks.map((c) => ({
        checkId: c.checkId,
        checkName: c.checkName,
        checkIdentity: c.checkIdentity ?? null,
        conclusion: c.conclusion,
        detailsUrl: `${base}/checks/${c.checkId}`,
      })),
      prUrl: `https://github.com/${input.repo}/pull/${input.prNumber}`,
    },
  };
}

export function buildPrReviewApprovalRequiredPayload(input: PrReviewApprovalRequiredEventInput) {
  const base = input.baseUrl.replace(/\/+$/, '');
  const identitySource =
    input.approvalId ??
    (input.promptId !== undefined
      ? `${input.segment ?? 1}:${input.executionGeneration ?? 0}:${input.promptId}`
      : null);
  const eventId = identitySource
    ? `jci_appr_${input.checkId}_${createHash('sha256').update(identitySource).digest('hex').slice(0, 12)}`
    : `jci_appr_${input.checkId}`;
  return {
    eventId,
    name: 'pr_review.approval_required' as const,
    repo: input.repo,
    prNumber: input.prNumber,
    conclusion: null,
    checkName: input.checkName,
    data: {
      checkId: input.checkId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      checkName: input.checkName,
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
      ...(input.executionGeneration !== undefined ? { executionGeneration: input.executionGeneration } : {}),
      ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
      detailsUrl: `${base}/checks/${input.checkId}`,
      prUrl: `https://github.com/${input.repo}/pull/${input.prNumber}`,
    },
  };
}

export async function emitPrReviewMcpEventSafely(
  eventInput: {
    eventId: string;
    name: McpEventName;
    repo?: string | null;
    prNumber?: number | null;
    conclusion?: string | null;
    checkName?: string | null;
    data: Record<string, unknown>;
  },
  store?: McpEventsStore,
): Promise<void> {
  if (!store && !process.env.DATABASE_URL) return;
  try {
    await publishMcpEvent(store ?? createDbMcpEventsStore(), eventInput);
  } catch (error) {
    console.warn(`[MCP Events] Failed to emit ${eventInput.name} (${eventInput.eventId}):`, error);
  }
}
