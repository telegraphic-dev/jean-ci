import { SYSTEM_PROMPT } from './db.ts';
import {
  buildGatewayAuthGuidance,
  classifyGatewayException,
  classifyGatewayHttpFailure,
  parseGatewayAuthRecoveryHint,
  runWithExponentialRetry,
} from './openclaw-gateway.ts';
import type { OpenClawGatewayFailure } from './openclaw-gateway.ts';
import { logExternalCallFailure, readResponseBodySnippet } from './external-call-logging.js';
import { REVIEW_AGENT_WAIT_TIMEOUT_MS } from './openclaw-review-timeouts.ts';
import { callGatewayRpc, isWebSocketEnabled } from './openclaw-ws.ts';

export const __internal = {
  isWebSocketEnabled,
  callGatewayRpc,
};

function normalizeSessionKeySegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalized || fallback;
}

export interface ReviewSessionMetadata {
  owner?: string;
  repo?: string;
  prNumber?: string | number;
  promptName?: string;
  headSha?: string;
}

function buildReviewSessionKey(metadata: ReviewSessionMetadata = {}): string {
  return `main:jean-ci:${normalizeSessionKeySegment(metadata.owner, 'unknown-org')}:${normalizeSessionKeySegment(metadata.repo, 'unknown-repo')}:${normalizeSessionKeySegment(metadata.prNumber?.toString(), 'unknown-pr')}:${normalizeSessionKeySegment(metadata.promptName, 'review')}:${normalizeSessionKeySegment(metadata.headSha, 'unknown-sha')}`;
}

function buildReviewSessionLabel(sessionKey: string): string {
  return `Jean CI Review · ${sessionKey}`.slice(0, 160);
}

function isOperatorAdminMissingScopeError(result: { error?: string; errorDetails?: unknown } | unknown): boolean {
  const errorText = typeof (result as { error?: string } | undefined)?.error === 'string'
    ? (result as { error?: string }).error
    : '';
  const detailsText = (() => {
    try {
      return JSON.stringify((result as { errorDetails?: unknown } | undefined)?.errorDetails ?? '');
    } catch {
      return '';
    }
  })();

  const haystack = `${errorText} ${detailsText}`.toLowerCase();
  return haystack.includes('missing scope') && haystack.includes('operator.admin');
}

// Use OpenResponses API for full agent capabilities (including browser tools)
// Falls back to chat/completions if OPENCLAW_USE_RESPONSES is not set
const USE_RESPONSES_API = process.env.OPENCLAW_USE_RESPONSES === 'true';

// Discriminated union type for proper TypeScript narrowing
type OpenClawResult = 
  | { success: true; response: string; error?: undefined }
  | { success: false; error: string; errorType: 'gateway' | 'unknown'; response?: undefined };

export async function callOpenClaw(userPrompt: string, context = '', metadata: ReviewSessionMetadata = {}): Promise<OpenClawResult> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const maxAttempts = getMaxAttempts();
  const retryBaseMs = getRetryBaseDelayMs();

  if (!gatewayUrl || !gatewayToken) {
    console.log('[MOCK] Would call OpenClaw');
    return { success: true, response: '**VERDICT: PASS**\n\n[Mock mode] Code looks good!' };
  }

  const userMessage = `${userPrompt}\n\n## Pull Request Details\n${context}`;
  const execution = await runWithExponentialRetry(async (attempt) => {
    const result = __internal.isWebSocketEnabled()
      ? await callOpenClawResponsesViaWebSocket(userMessage, metadata)
      : USE_RESPONSES_API
        ? await callOpenClawResponses(userMessage, gatewayUrl, gatewayToken, attempt, maxAttempts)
        : await callOpenClawChat(userMessage, gatewayUrl, gatewayToken, attempt, maxAttempts);

    if (!result.success) {
      console.error(`OpenClaw gateway attempt ${attempt}/${maxAttempts} failed (${result.failure.errorType}): ${result.failure.error}`);
      return { success: false as const, failure: result.failure };
    }

    return { success: true as const, value: result.response };
  }, {
    maxAttempts,
    retryBaseMs,
  });

  if (execution.success) {
    return { success: true, response: execution.value };
  }

  return {
    success: false,
    errorType: execution.failure.errorType,
    error: `OpenClaw request failed after ${execution.attempts} attempt(s). Last error: ${execution.failure.error}`,
  };
}

/**
 * Session-based WebSocket RPC flow.
 * Uses only exported session methods: sessions.create -> sessions.send -> sessions.get.
 */
async function callOpenClawResponsesViaWebSocket(
  userMessage: string,
  metadata: ReviewSessionMetadata = {},
): Promise<{ success: true; response: string } | { success: false; failure: OpenClawGatewayFailure }> {
  const sessionKey = buildReviewSessionKey(metadata);

  try {
    const createResult = await __internal.callGatewayRpc<{ key?: string }>('sessions.create', {
      key: sessionKey,
      label: buildReviewSessionLabel(sessionKey),
    });

    if (!createResult.success) {
      const detailBlob = createResult.errorDetails ? JSON.stringify({ errorDetails: createResult.errorDetails }) : '';
      return {
        success: false,
        failure: classifyGatewayException(new Error(detailBlob ? `${createResult.error} ${detailBlob}` : createResult.error)),
      };
    }

    const sendResult = await __internal.callGatewayRpc<{ runId?: string; status?: string; messageSeq?: number }>('sessions.send', {
      key: sessionKey,
      message: `${SYSTEM_PROMPT}

${userMessage}`,
      idempotencyKey: `jean-ci-${Date.now()}`,
    });

    if (!sendResult.success) {
      const detailBlob = sendResult.errorDetails ? JSON.stringify({ errorDetails: sendResult.errorDetails }) : '';
      return {
        success: false,
        failure: classifyGatewayException(new Error(detailBlob ? `${sendResult.error} ${detailBlob}` : sendResult.error)),
      };
    }

    const runId = typeof sendResult.result?.runId === 'string' ? sendResult.result.runId : null;
    if (!runId) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'sessions.send did not return a runId' },
      };
    }

    const waitResult = await __internal.callGatewayRpc<{ runId?: string; status?: string; error?: string }>('agent.wait', {
      runId,
      timeoutMs: REVIEW_AGENT_WAIT_TIMEOUT_MS,
    });

    if (!waitResult.success) {
      const detailBlob = waitResult.errorDetails ? JSON.stringify({ errorDetails: waitResult.errorDetails }) : '';
      return {
        success: false,
        failure: classifyGatewayException(new Error(detailBlob ? `${waitResult.error} ${detailBlob}` : waitResult.error)),
      };
    }

    if (waitResult.result?.status === 'timeout') {
      return {
        success: false,
        failure: { errorType: 'gateway', retryable: true, error: 'Timed out waiting for OpenClaw agent run to finish' },
      };
    }

    if (waitResult.result?.status === 'error') {
      return {
        success: false,
        failure: {
          errorType: 'unknown',
          retryable: false,
          error: waitResult.result.error || 'OpenClaw agent run failed',
        },
      };
    }

    const transcriptResult = await __internal.callGatewayRpc<{ messages?: Array<{ role?: string; content?: string | Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }> }>('sessions.get', {
      key: sessionKey,
      limit: 50,
    });

    if (!transcriptResult.success) {
      const detailBlob = transcriptResult.errorDetails ? JSON.stringify({ errorDetails: transcriptResult.errorDetails }) : '';
      return {
        success: false,
        failure: classifyGatewayException(new Error(detailBlob ? `${transcriptResult.error} ${detailBlob}` : transcriptResult.error)),
      };
    }

    const responseText = extractAssistantTextFromSessionMessages(transcriptResult.result?.messages || []);
    if (!responseText) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'No assistant response found in session transcript' },
      };
    }

    return { success: true, response: responseText };
  } catch (error) {
    return { success: false, failure: classifyGatewayException(error) };
  } finally {
    try {
      const deleteResult = await __internal.callGatewayRpc('sessions.delete', {
        key: sessionKey,
      });

      if (!deleteResult.success) {
        if (isOperatorAdminMissingScopeError(deleteResult)) {
          console.warn('Skipped OpenClaw review session deletion because caller lacks operator.admin', {
            sessionKey,
            error: deleteResult.error,
          });
        } else {
          console.warn('Failed to delete OpenClaw review session', {
            sessionKey,
            error: deleteResult.error,
            errorDetails: deleteResult.errorDetails,
          });
        }
      }
    } catch (cleanupError) {
      console.warn('Failed to delete OpenClaw review session', {
        sessionKey,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}
/**
 * OpenResponses API (/v1/responses)
 * Full agent codepath with tool access (browser, exec, etc.)
 */
async function callOpenClawResponses(
  userMessage: string,
  gatewayUrl: string,
  gatewayToken: string,
  attempt: number,
  maxAttempts: number,
): Promise<{ success: true; response: string } | { success: false; failure: OpenClawGatewayFailure }> {
  const url = `${gatewayUrl}/v1/responses`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
        'x-openclaw-agent-id': 'main',
      },
      body: JSON.stringify({
        model: process.env.OPENCLAW_RESPONSES_MODEL || 'openclaw',
        input: [
          { type: 'message', role: 'developer', content: SYSTEM_PROMPT },
          { type: 'message', role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const responseBody = await readResponseBodySnippet(response);
      const failure = enrichGatewayHttpFailure(response.status, responseBody || 'No response body');
      logExternalCallFailure({
        service: 'openclaw_gateway',
        operation: 'openclaw.responses.create',
        url,
        method: 'POST',
        phase: 'remote_response',
        status: response.status,
        responseBody,
        attempt,
        maxAttempts,
        retryable: failure.retryable,
      });
      return { success: false, failure };
    }

    const data = await response.json();
    const textContent = extractTextFromOutput(data.output || []);
    if (!textContent) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'No text response from agent' },
      };
    }

    return { success: true, response: textContent };
  } catch (error) {
    const failure = classifyGatewayException(error);
    logExternalCallFailure({
      service: 'openclaw_gateway',
      operation: 'openclaw.responses.create',
      url,
      method: 'POST',
      phase: 'transport',
      attempt,
      maxAttempts,
      retryable: failure.retryable,
      error,
    });
    return { success: false, failure };
  }
}

/**
 * Chat Completions API (/v1/chat/completions)
 * Simple LLM call without tool access
 */
async function callOpenClawChat(
  userMessage: string,
  gatewayUrl: string,
  gatewayToken: string,
  attempt: number,
  maxAttempts: number,
): Promise<{ success: true; response: string } | { success: false; failure: OpenClawGatewayFailure }> {
  const url = `${gatewayUrl}/v1/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        model: process.env.OPENCLAW_CHAT_MODEL || 'openclaw',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const responseBody = await readResponseBodySnippet(response);
      const failure = enrichGatewayHttpFailure(response.status, responseBody || 'No response body');
      logExternalCallFailure({
        service: 'openclaw_gateway',
        operation: 'openclaw.chat_completions.create',
        url,
        method: 'POST',
        phase: 'remote_response',
        status: response.status,
        responseBody,
        attempt,
        maxAttempts,
        retryable: failure.retryable,
      });
      return { success: false, failure };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'No response content from chat completion' },
      };
    }

    return { success: true, response: content };
  } catch (error) {
    const failure = classifyGatewayException(error);
    logExternalCallFailure({
      service: 'openclaw_gateway',
      operation: 'openclaw.chat_completions.create',
      url,
      method: 'POST',
      phase: 'transport',
      attempt,
      maxAttempts,
      retryable: failure.retryable,
      error,
    });
    return { success: false, failure };
  }
}

function enrichGatewayHttpFailure(status: number, responseBody: string): OpenClawGatewayFailure {
  const failure = classifyGatewayHttpFailure(status, responseBody);
  const guidance = buildGatewayAuthGuidance(parseGatewayAuthRecoveryHint(responseBody));

  if (!guidance) {
    return failure;
  }

  return {
    ...failure,
    error: `${failure.error} ${guidance}`,
  };
}

function extractAssistantTextFromSessionMessages(
  messages: Array<{ role?: string; content?: string | Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;

    if (typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => part?.text)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim();
      if (text) return text;
    }

    const nested = message.message?.content;
    if (Array.isArray(nested)) {
      const text = nested
        .map((part) => part?.text)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }

  return null;
}

/**
 * Extract text content from OpenResponses output items
 */
function extractTextFromOutput(output: any[]): string {
  const textParts: string[] = [];
  
  for (const item of output) {
    if (item.type === 'message' && item.content) {
      // Content can be string or array of content parts
      if (typeof item.content === 'string') {
        textParts.push(item.content);
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' || part.type === 'text') {
            textParts.push(part.text || '');
          }
        }
      }
    }
  }
  
  return textParts.join('\n').trim();
}

function getMaxAttempts() {
  return Math.max(1, parseInt(process.env.OPENCLAW_GATEWAY_MAX_ATTEMPTS || '3', 10));
}

function getRetryBaseDelayMs() {
  return Math.max(0, parseInt(process.env.OPENCLAW_GATEWAY_RETRY_BASE_MS || '100', 10));
}
