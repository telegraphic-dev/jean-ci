import { SYSTEM_PROMPT } from './db';

// Use OpenResponses API for full agent capabilities (including browser tools)
// Falls back to chat/completions if OPENCLAW_USE_RESPONSES is not set
const USE_RESPONSES_API = process.env.OPENCLAW_USE_RESPONSES === 'true';

// Discriminated union type for proper TypeScript narrowing
type OpenClawResult = 
  | { success: true; response: string; error?: undefined }
  | { success: false; error: string; errorType: 'gateway'; response?: undefined };

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
  let lastError = 'Unknown gateway error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = USE_RESPONSES_API
        ? await callOpenClawResponses(userMessage, gatewayUrl, gatewayToken)
        : await callOpenClawChat(userMessage, gatewayUrl, gatewayToken);

      if (result.success) {
        return result;
      }

      lastError = result.error;
      console.error(`OpenClaw gateway attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
    } catch (error: any) {
      lastError = error?.message || String(error);
      console.error(`OpenClaw gateway attempt ${attempt}/${maxAttempts} errored: ${lastError}`);
    }

    if (attempt < maxAttempts) {
      await sleep(getRetryDelayMs(attempt, retryBaseMs));
    }
  }

  return {
    success: false,
    errorType: 'gateway',
    error: `OpenClaw gateway failed after ${maxAttempts} attempts. Last error: ${lastError}`,
  };
}

/**
 * OpenResponses API (/v1/responses)
 * Full agent codepath with tool access (browser, exec, etc.)
 */
async function callOpenClawResponses(userMessage: string, gatewayUrl: string, gatewayToken: string): Promise<OpenClawResult> {
  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`,
      'x-openclaw-agent-id': 'main',
    },
    body: JSON.stringify({
      model: 'openclaw:main',
      input: [
        { type: 'message', role: 'developer', content: SYSTEM_PROMPT },
        { type: 'message', role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    return { success: false, error: await response.text() };
  }

  const data = await response.json();
  
  // Extract text from output items
  const textContent = extractTextFromOutput(data.output || []);
  
  if (!textContent) {
    return { success: false, error: 'No text response from agent' };
  }
  
  return { success: true, response: textContent };
}

/**
 * Chat Completions API (/v1/chat/completions)
 * Simple LLM call without tool access
 */
async function callOpenClawChat(userMessage: string, gatewayUrl: string, gatewayToken: string): Promise<OpenClawResult> {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      model: 'default',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    return { success: false, error: await response.text() };
  }

  const data = await response.json();
  return { success: true, response: data.choices?.[0]?.message?.content || 'No response' };
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMaxAttempts() {
  return Math.max(1, parseInt(process.env.OPENCLAW_GATEWAY_MAX_ATTEMPTS || '3', 10));
}

function getRetryBaseDelayMs() {
  return Math.max(0, parseInt(process.env.OPENCLAW_GATEWAY_RETRY_BASE_MS || '100', 10));
}

export function getRetryDelayMs(attempt: number, retryBaseMs: number) {
  return retryBaseMs * 2 ** (attempt - 1);
}
