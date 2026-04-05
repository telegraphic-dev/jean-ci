import { createHash } from 'node:crypto';
import { callGatewayRpc } from './openclaw-ws.ts';
import { getRepoFeatureSessions, upsertRepoFeatureSession } from './db.ts';
import { buildFeatureSessionKeyPrefix } from './repo-feature-sessions.ts';

const MAX_FEATURE_SESSION_MESSAGE_LENGTH = 20_000;
const FEATURE_SESSION_CHAT_TRANSCRIPT_LIMIT = 500;
const FINAL_ASSISTANT_ROLES = new Set(['assistant']);
const NON_FINAL_ROLES = new Set(['system', 'tool', 'unknown']);

export interface RepoFeatureSessionChatDeps {
  getRepoFeatureSessions: typeof getRepoFeatureSessions;
  upsertRepoFeatureSession: typeof upsertRepoFeatureSession;
  callGatewayRpc: typeof callGatewayRpc;
}

const defaultDeps: RepoFeatureSessionChatDeps = {
  getRepoFeatureSessions,
  upsertRepoFeatureSession,
  callGatewayRpc,
};

export interface RepoFeatureSessionChatMessage {
  role: string;
  text: string;
}

export interface RepoFeatureSessionChatState {
  sessionKey: string;
  messages: RepoFeatureSessionChatMessage[];
  runStatus: 'idle' | 'running' | 'timeout' | 'error';
  runId?: string;
  error?: string;
}

export async function getRepoFeatureSessionChat(
  repoFullName: string,
  sessionKey: string,
  deps: RepoFeatureSessionChatDeps = defaultDeps,
): Promise<RepoFeatureSessionChatState> {
  const session = await requireRepoFeatureSession(repoFullName, sessionKey, deps);
  const transcriptResult = await deps.callGatewayRpc<{ messages?: unknown[] }>('sessions.get', {
    key: session.session_key,
    limit: FEATURE_SESSION_CHAT_TRANSCRIPT_LIMIT,
  });

  if (!transcriptResult.success) {
    throw new Error(transcriptResult.error);
  }

  const messages = normalizeMessages(transcriptResult.result?.messages || []);

  return {
    sessionKey: session.session_key,
    messages,
    runStatus: inferRunStatusFromMessages(messages),
  };
}

export async function sendRepoFeatureSessionChatMessage(
  repoFullName: string,
  sessionKey: string,
  message: string,
  requestId: string,
  deps: RepoFeatureSessionChatDeps = defaultDeps,
): Promise<RepoFeatureSessionChatState> {
  const session = await requireRepoFeatureSession(repoFullName, sessionKey, deps);
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('message is required');
  }
  if (trimmed.length > MAX_FEATURE_SESSION_MESSAGE_LENGTH) {
    throw new Error(`message exceeds ${MAX_FEATURE_SESSION_MESSAGE_LENGTH} characters`);
  }

  const sendResult = await deps.callGatewayRpc<{ runId?: string; status?: string }>('sessions.send', {
    key: session.session_key,
    message: trimmed,
    idempotencyKey: buildFeatureSessionIdempotencyKey(session.session_key, requestId, trimmed),
  });

  if (!sendResult.success) {
    throw new Error(sendResult.error);
  }

  const runId = typeof sendResult.result?.runId === 'string' ? sendResult.result.runId : undefined;
  let runStatus: RepoFeatureSessionChatState['runStatus'] = mapSessionsSendStatusToRunStatus(sendResult.result?.status);
  let runError: string | undefined;

  if (runId || runStatus === 'running') {
    const waitPayload = runId
      ? { runId, timeoutMs: 30_000 }
      : { key: session.session_key, timeoutMs: 30_000 };
    const waitResult = await deps.callGatewayRpc<{ status?: string; error?: string }>('agent.wait', waitPayload);

    if (!waitResult.success) {
      throw new Error(waitResult.error);
    }

    if (waitResult.result?.status === 'timeout') {
      runStatus = 'timeout';
      runError = 'Timed out waiting for assistant reply';
    } else if (waitResult.result?.status === 'error') {
      runStatus = 'error';
      runError = waitResult.result.error || 'Assistant run failed';
    } else if (waitResult.result?.status === 'ok') {
      runStatus = 'idle';
    } else {
      runStatus = 'running';
      runError = waitResult.result?.status ? `Run still in progress: ${waitResult.result.status}` : undefined;
    }
  }

  const transcriptResult = await deps.callGatewayRpc<{ messages?: unknown[] }>('sessions.get', {
    key: session.session_key,
    limit: FEATURE_SESSION_CHAT_TRANSCRIPT_LIMIT,
  });

  if (!transcriptResult.success) {
    throw new Error(transcriptResult.error);
  }

  const messages = normalizeMessages(transcriptResult.result?.messages || []);
  const inferredRunStatus = inferRunStatusFromMessages(messages);
  const finalRunStatus = runStatus === 'idle' ? inferredRunStatus : runStatus;

  const now = new Date();
  await deps.upsertRepoFeatureSession({
    session_key: session.session_key,
    repo_full_name: session.repo_full_name,
    title: session.title,
    branch_name: session.branch_name,
    status: session.status,
    session_url: session.session_url,
    pr_number: session.pr_number,
    pr_url: session.pr_url,
    last_activity_at: now,
  });

  return {
    sessionKey: session.session_key,
    messages,
    runStatus: finalRunStatus,
    runId,
    error: runError,
  };
}

export function buildFeatureSessionIdempotencyKey(sessionKey: string, requestId: string, message: string): string {
  const hash = createHash('sha256')
    .update(sessionKey)
    .update('\n')
    .update(requestId)
    .update('\n')
    .update(message)
    .digest('hex');

  return `repo-feature-chat-${hash}`;
}

async function requireRepoFeatureSession(
  repoFullName: string,
  sessionKey: string,
  deps: RepoFeatureSessionChatDeps,
) {
  if (!sessionKey.startsWith(buildFeatureSessionKeyPrefix(repoFullName))) {
    throw new Error('Feature session key does not belong to this repository');
  }

  const sessions = await deps.getRepoFeatureSessions(repoFullName);
  const match = sessions.find((item) => item.session_key === sessionKey);
  if (!match) {
    throw new Error('Feature session not found');
  }
  return match;
}

function normalizeMessages(input: unknown[]): RepoFeatureSessionChatMessage[] {
  const messages: RepoFeatureSessionChatMessage[] = [];

  for (const item of input) {
    if (!isRecord(item)) continue;
    const role = typeof item.role === 'string' ? item.role : 'unknown';
    const text = extractMessageText(item);
    if (!text) continue;
    messages.push({ role, text });
  }

  return messages;
}

function inferRunStatusFromMessages(messages: RepoFeatureSessionChatMessage[]): RepoFeatureSessionChatState['runStatus'] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (!role || NON_FINAL_ROLES.has(role)) continue;
    if (FINAL_ASSISTANT_ROLES.has(role)) return 'idle';
    if (role === 'user') return 'running';
  }

  return 'idle';
}

function mapSessionsSendStatusToRunStatus(status: string | undefined): RepoFeatureSessionChatState['runStatus'] {
  if (!status) return 'running';
  if (status === 'ok' || status === 'completed') return 'idle';
  if (status === 'error' || status === 'failed') return 'error';
  return 'running';
}

function extractMessageText(message: Record<string, unknown>): string {
  const direct = contentToText(message.content);
  if (direct) return direct;

  if (isRecord(message.message)) {
    return contentToText(message.message.content);
  }

  if (typeof message.text === 'string') {
    return message.text.trim();
  }

  return '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();

  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
