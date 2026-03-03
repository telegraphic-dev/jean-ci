import { SYSTEM_PROMPT } from './db';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

// Use OpenResponses API for full agent capabilities (including browser tools)
// Falls back to chat/completions if OPENCLAW_USE_RESPONSES is not set
const USE_RESPONSES_API = process.env.OPENCLAW_USE_RESPONSES === 'true';

// Discriminated union type for proper TypeScript narrowing
type OpenClawResult = 
  | { success: true; response: string; error?: undefined }
  | { success: false; error: string; response?: undefined };

export async function callOpenClaw(userPrompt: string, context = ''): Promise<OpenClawResult> {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('[MOCK] Would call OpenClaw');
    return { success: true, response: '**VERDICT: PASS**\n\n[Mock mode] Code looks good!' };
  }

  const userMessage = `${userPrompt}\n\n## Pull Request Details\n${context}`;

  try {
    if (USE_RESPONSES_API) {
      return await callOpenClawResponses(userMessage);
    } else {
      return await callOpenClawChat(userMessage);
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * OpenResponses API (/v1/responses)
 * Full agent codepath with tool access (browser, exec, etc.)
 */
async function callOpenClawResponses(userMessage: string): Promise<OpenClawResult> {
  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
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
async function callOpenClawChat(userMessage: string): Promise<OpenClawResult> {
  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
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
