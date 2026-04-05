import { createHash } from 'node:crypto';
import { callGatewayRpc } from './openclaw-ws.ts';
import { getRepoFeatureSessions, upsertRepoFeatureSession } from './db.ts';

const MAX_FEATURE_SESSION_MESSAGE_LENGTH = 20_000;

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
    limit: 100,
  });

  if (!transcriptResult.success) {
    throw new Error(transcriptResult.error);
  }

  return {
    sessionKey: session.session_key,
    messages: normalizeMessages(transcriptResult.result?.messages || []),
    runStatus: inferRunStatusFromMessages(transcriptResult.result?.messages || []),
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
  let runStatus: RepoFeatureSessionChatState['runStatus'] = 'running';
  let runError: string | undefined;

  if (runId) {
    const waitResult = await deps.callGatewayRpc<{ status?: string; error?: string }>('agent.wait', {
      runId,
      timeoutMs: 30_000,
    });

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
    limit: 100,
  });

  if (!transcriptResult.success) {
    throw new Error(transcriptResult.error);
  }

  const messages = normalizeMessages(transcriptResult.result?.messages || []);
  const inferredRunStatus = inferRunStatusFromMessages(transcriptResult.result?.messages || []);
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

function inferRunStatusFromMessages(input: unknown[]): RepoFeatureSessionChatState['runStatus'] {
  const messages = normalizeMessages(input);
  const last = messages.at(-1);
  if (!last) return 'idle';
  return last.role === 'user' ? 'running' : 'idle';
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
