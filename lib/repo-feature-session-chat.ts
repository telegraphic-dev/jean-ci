import { callGatewayRpc } from './openclaw-ws.ts';
import { getRepoFeatureSessions, upsertRepoFeatureSession } from './db.ts';

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
    runStatus: 'idle',
  };
}

export async function sendRepoFeatureSessionChatMessage(
  repoFullName: string,
  sessionKey: string,
  message: string,
  deps: RepoFeatureSessionChatDeps = defaultDeps,
): Promise<RepoFeatureSessionChatState> {
  const session = await requireRepoFeatureSession(repoFullName, sessionKey, deps);
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('message is required');
  }

  const sendResult = await deps.callGatewayRpc<{ runId?: string; status?: string }>('sessions.send', {
    key: session.session_key,
    message: trimmed,
    idempotencyKey: `repo-feature-chat-${Date.now()}`,
  });

  if (!sendResult.success) {
    throw new Error(sendResult.error);
  }

  const runId = typeof sendResult.result?.runId === 'string' ? sendResult.result.runId : undefined;
  let runStatus: RepoFeatureSessionChatState['runStatus'] = 'idle';
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
    } else if (waitResult.result?.status && waitResult.result.status !== 'ok') {
      runStatus = 'running';
    }
  }

  const transcriptResult = await deps.callGatewayRpc<{ messages?: unknown[] }>('sessions.get', {
    key: session.session_key,
    limit: 100,
  });

  if (!transcriptResult.success) {
    throw new Error(transcriptResult.error);
  }

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
    messages: normalizeMessages(transcriptResult.result?.messages || []),
    runStatus,
    runId,
    error: runError,
  };
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
