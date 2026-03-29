import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGatewayException } from '../lib/openclaw-gateway.ts';

function extractTextFromOutput(output: any[]): string {
  const textParts: string[] = [];

  for (const item of output) {
    if (item.type === 'message' && item.content) {
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

async function callOpenClawResponsesViaWebSocketForTest(
  userMessage: string,
  callGatewayRpc: (method: string, params: Record<string, unknown>) => Promise<{ success: true; result: { output?: any[] } } | { success: false; error: string }>,
): Promise<{ success: true; response: string } | { success: false; failure: ReturnType<typeof classifyGatewayException> }> {
  try {
    const result = await callGatewayRpc('responses.create', {
      model: 'openclaw',
      input: [
        { type: 'message', role: 'developer', content: 'system prompt' },
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

test('websocket LLM path sends responses.create and extracts text output', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const result = await callOpenClawResponsesViaWebSocketForTest('Review this PR', async (method, params) => {
    calls.push({ method, params });
    return {
      success: true,
      result: {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '**VERDICT: PASS**\n\nLooks good.' }],
          },
        ],
      },
    };
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.match(result.response, /VERDICT: PASS/);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'responses.create');
  assert.equal((calls[0]?.params.input as Array<unknown>).length, 2);
});

test('websocket LLM path classifies RPC transport failures as gateway errors', async () => {
  const result = await callOpenClawResponsesViaWebSocketForTest('Review this PR', async () => ({
    success: false,
    error: 'Connection timeout after 10000ms',
  }));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.failure.errorType, 'gateway');
    assert.equal(result.failure.retryable, true);
  }
});
