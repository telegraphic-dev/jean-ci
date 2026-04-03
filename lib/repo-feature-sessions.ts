import { randomUUID } from 'node:crypto';
import { callGatewayRpc } from './openclaw-ws.ts';
import { upsertRepoFeatureSession } from './db.ts';
import { buildRepoSessionSeedPrompt } from './repo-feature-session-prompt.ts';

export interface FeatureSessionSummary {
  key: string;
  label: string;
  repoFullName: string;
  branchName?: string | null;
  status: string;
  lastActivityAt?: string | null;
  sessionUrl?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
}

type GatewaySessionLike = Record<string, unknown>;

export interface CreateFeatureSessionInput {
  repoFullName: string;
  title: string;
  branchName?: string | null;
}

export async function listGatewayFeatureSessions(limit = 200): Promise<FeatureSessionSummary[]> {
  const result = await callGatewayRpc<unknown>('sessions.list', { limit });
  if (!result.success) {
    console.warn('[repo-feature-sessions] Failed to list sessions from gateway:', result.error);
    return [];
  }

  const raw = result.result;
  const rawItems = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.items)
      ? raw.items
      : [];

  const normalized: FeatureSessionSummary[] = [];
  for (const item of rawItems) {
    const parsed = normalizeGatewaySession(item);
    if (parsed) normalized.push(parsed);
  }

  return normalized;
}

export function normalizeGatewaySession(item: unknown): FeatureSessionSummary | null {
  if (!isRecord(item)) return null;

  const key = pickString(item, ['key', 'sessionKey', 'id']);
  const repoFullName = resolveRepoFullName(item);
  if (!key || !repoFullName || !repoFullName.includes('/')) {
    return null;
  }

  const label = pickString(item, ['label', 'title', 'name']) || key;
  const branchName = pickNestedString(item, [['branchName'], ['branch'], ['metadata', 'branchName'], ['metadata', 'branch']]);
  const status = pickNestedString(item, [['status'], ['state'], ['metadata', 'status']]) || 'active';
  const lastActivityAt = pickNestedString(item, [
    ['lastActivityAt'],
    ['updatedAt'],
    ['lastMessageAt'],
    ['last_activity'],
    ['metadata', 'lastActivityAt'],
  ]);
  const sessionUrl = pickNestedString(item, [['url'], ['deepLink'], ['sessionUrl'], ['metadata', 'url'], ['metadata', 'deepLink'], ['metadata', 'sessionUrl']]);
  const prUrl = pickNestedString(item, [['prUrl'], ['metadata', 'prUrl']]);
  const prNumber = pickOptionalNumber(item, [['prNumber'], ['metadata', 'prNumber']]);

  return {
    key,
    label,
    repoFullName,
    branchName,
    status,
    lastActivityAt,
    sessionUrl,
    prNumber,
    prUrl,
  };
}

function resolveRepoFullName(item: GatewaySessionLike): string | null {
  return pickNestedString(item, [
    ['repoFullName'],
    ['repo'],
    ['repository'],
    ['metadata', 'repoFullName'],
    ['metadata', 'repo'],
    ['metadata', 'repository'],
    ['context', 'repoFullName'],
    ['context', 'repo'],
    ['context', 'repository'],
  ]);
}

function pickOptionalNumber(source: GatewaySessionLike, paths: string[][]): number | null {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function pickString(source: GatewaySessionLike, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pickNestedString(source: GatewaySessionLike, paths: string[][]): string | null {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getNestedValue(source: GatewaySessionLike, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export async function createRepoFeatureSession(input: CreateFeatureSessionInput): Promise<FeatureSessionSummary> {
  const repoFullName = input.repoFullName.trim();
  const title = input.title.trim();
  const branchName = input.branchName?.trim() || null;

  if (!repoFullName || !repoFullName.includes('/')) {
    throw new Error('repoFullName must be in owner/repo format');
  }
  if (!title) {
    throw new Error('title is required');
  }

  const sessionKey = buildFeatureSessionKey(repoFullName);
  const label = `${repoFullName} · ${title}`;

  const createResult = await callGatewayRpc<{ key?: string; url?: string; deepLink?: string; sessionUrl?: string }>('sessions.create', {
    key: sessionKey,
    label,
  });
  if (!createResult.success) {
    throw new Error(createResult.error);
  }

  const sessionUrl = pickSessionUrl(createResult.result);

  const seedPrompt = [
    buildRepoSessionSeedPrompt(repoFullName),
    '',
    `Session title: ${title}`,
    branchName ? `Suggested branch: ${branchName}` : null,
    `Session key: ${sessionKey}`,
  ].filter(Boolean).join('\n');

  const sendResult = await callGatewayRpc('sessions.send', {
    key: sessionKey,
    message: seedPrompt,
    idempotencyKey: `repo-feature-session-${randomUUID()}`,
  });
  if (!sendResult.success) {
    throw new Error(sendResult.error);
  }

  await upsertRepoFeatureSession({
    session_key: sessionKey,
    repo_full_name: repoFullName,
    title,
    branch_name: branchName,
    status: 'active',
    session_url: sessionUrl,
    last_activity_at: new Date(),
  });

  return {
    key: sessionKey,
    label,
    repoFullName,
    branchName,
    status: 'active',
    lastActivityAt: new Date().toISOString(),
    sessionUrl,
    prNumber: null,
    prUrl: null,
  };
}

function buildFeatureSessionKey(repoFullName: string): string {
  const repoSlug = repoFullName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `main:jean-ci:${repoSlug}:feature:${randomUUID()}`;
}

function pickSessionUrl(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return pickNestedString(payload, [['url'], ['deepLink'], ['sessionUrl']]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
