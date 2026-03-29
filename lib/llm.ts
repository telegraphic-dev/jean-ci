import { SYSTEM_PROMPT } from './db';
import {
  buildGatewayAuthGuidance,
  classifyGatewayException,
  classifyGatewayHttpFailure,
  OpenClawGatewayFailure,
  parseGatewayAuthRecoveryHint,
  runWithExponentialRetry,
} from './openclaw-gateway';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logExternalCallFailure, readResponseBodySnippet } from './external-call-logging.js';

type GatewayRpcResult<T> =
  | { success: true; result: T }
  | { success: false; error: string };

type OpenClawWsModule = {
  isWebSocketEnabled: () => boolean;
  callGatewayRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<GatewayRpcResult<T>>;
};

async function loadOpenClawWs(): Promise<OpenClawWsModule> {
  if (process.env.NODE_ENV === 'production' && process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFilePath);
    const standaloneCandidates = [
      path.resolve(process.cwd(), 'lib', 'openclaw-ws.ts'),
      path.resolve(process.cwd(), '.next', 'standalone', 'lib', 'openclaw-ws.ts'),
      path.resolve(currentDir, 'openclaw-ws.ts'),
      path.resolve(currentDir, '..', 'lib', 'openclaw-ws.ts'),
    ];

    const standaloneModulePath = standaloneCandidates.find((candidate) => fs.existsSync(candidate));

    if (!standaloneModulePath) {
      throw new Error(`Unable to locate standalone openclaw-ws module. Tried: ${standaloneCandidates.join(', ')}`);
    }

    return import(pathToFileURL(standaloneModulePath).href);
  }

  return import('./openclaw-ws');
}

export const __internal = {
  async isWebSocketEnabled(): Promise<boolean> {
    const ws = await loadOpenClawWs();
    return ws.isWebSocketEnabled();
  },
  async callGatewayRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<GatewayRpcResult<T>> {
    const ws = await loadOpenClawWs();
    return ws.callGatewayRpc<T>(method, params);
  },
};

// Use OpenResponses API for full agent capabilities (including browser tools)
// Falls back to chat/completions if OPENCLAW_USE_RESPONSES is not set
const USE_RESPONSES_API = process.env.OPENCLAW_USE_RESPONSES === 'true';

// Discriminated union type for proper TypeScript narrowing
type OpenClawResult = 
  | { success: true; response: string; error?: undefined }
  | { success: false; error: string; errorType: 'gateway' | 'unknown'; response?: undefined };

export async function callOpenClaw(userPrompt: string, context = ''): Promise<OpenClawResult> {
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
    const useWebSocket = await __internal.isWebSocketEnabled();
    const result = useWebSocket
      ? await callOpenClawResponsesViaWebSocket(userMessage)
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
 * OpenResponses API over WebSocket RPC.
 * Uses the same responses.create flow as /v1/responses, but through gateway RPC.
 */
async function callOpenClawResponsesViaWebSocket(
  userMessage: string,
): Promise<{ success: true; response: string } | { success: false; failure: OpenClawGatewayFailure }> {
  try {
    const result = await __internal.callGatewayRpc<{ output?: any[] }>('responses.create', {
      model: process.env.OPENCLAW_RESPONSES_MODEL || 'openclaw',
      input: [
        { type: 'message', role: 'developer', content: SYSTEM_PROMPT },
        { type: 'message', role: 'user', content: userMessage },
      ],
    });

    if (!result.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(result.error)),
      };
    }

    const textContent = extractTextFromOutput(result.result.output || []);
    if (!textContent) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'No text response from agent' },
      };
    }

    return { success: true, response: textContent };
  } catch (error) {
    return { success: false, failure: classifyGatewayException(error) };
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
