import { callGatewayRpc } from './openclaw-ws.ts';

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

export function buildRepoSessionSeedPrompt(repoFullName: string): string {
  return [
    `This feature session is permanently bound to repository ${repoFullName}.`,
    'Operate only within this repository unless the user explicitly instructs otherwise.',
    'When you create a PR from this session, include both:',
    '- a hidden marker in the PR body: <!-- oc-session:SESSION_KEY -->',
    '- a visible Jean-CI session backlink using the session deep link when available.',
    'Assume PR review and CI feedback will be injected back into this same session for further iteration.',
  ].join('\n');
}

export async function listGatewayFeatureSessions(limit = 200): Promise<FeatureSessionSummary[]> {
  const result = await callGatewayRpc<any>('sessions.list', { limit });
  if (!result.success) {
    console.warn('[repo-feature-sessions] Failed to list sessions from gateway:', result.error);
    return [];
  }

  const rawItems = Array.isArray(result.result)
    ? result.result
    : Array.isArray((result.result as any)?.items)
      ? (result.result as any).items
      : [];

  return rawItems
    .map((item: any) => normalizeGatewaySession(item))
    .filter((item: FeatureSessionSummary | null): item is FeatureSessionSummary => item !== null);
}

function normalizeGatewaySession(item: any): FeatureSessionSummary | null {
  const key = pickString(item, ['key', 'sessionKey', 'id']);
  const label = pickString(item, ['label', 'title', 'name']) || key || 'session';
  const repoFullName = pickString(item, ['repoFullName', 'repo', 'repository'])
    || pickString(item?.metadata, ['repoFullName', 'repo', 'repository'])
    || pickString(item?.context, ['repoFullName', 'repo', 'repository']);

  if (!key || !repoFullName || !repoFullName.includes('/')) {
    return null;
  }

  const branchName = pickString(item, ['branchName', 'branch'])
    || pickString(item?.metadata, ['branchName', 'branch']);
  const status = pickString(item, ['status', 'state'])
    || pickString(item?.metadata, ['status'])
    || 'active';
  const lastActivityAt = pickString(item, ['lastActivityAt', 'updatedAt', 'lastMessageAt', 'last_activity'])
    || pickString(item?.metadata, ['lastActivityAt']);
  const sessionUrl = pickString(item, ['url', 'deepLink', 'sessionUrl'])
    || pickString(item?.metadata, ['url', 'deepLink', 'sessionUrl']);
  const prUrl = pickString(item, ['prUrl']) || pickString(item?.metadata, ['prUrl']);
  const prNumberRaw = item?.prNumber ?? item?.metadata?.prNumber;
  const prNumber = typeof prNumberRaw === 'number'
    ? prNumberRaw
    : typeof prNumberRaw === 'string' && /^\d+$/.test(prNumberRaw)
      ? Number(prNumberRaw)
      : null;

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

function pickString(source: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
