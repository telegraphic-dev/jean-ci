import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGatewayException } from '../lib/openclaw-gateway.ts';

async function callOpenClawResponsesViaWebSocketForTest(
  userMessage: string,
  callGatewayRpc: (method: string, params: Record<string, unknown>) => Promise<{ success: true; result: { output?: any[] } } | { success: false; error: string }>,
): Promise<{ success: true; response: string } | { success: false; failure: ReturnType<typeof classifyGatewayException> }> {
  try {
    const result = await callGatewayRpc('chat.send', {
      text: `system prompt\n\n${userMessage}`,
    });

    if (!result.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(result.error)),
      };
    }

    if (!result.result || (typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false)) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'chat.send did not accept the message' },
      };
    }

    return { success: true, response: 'chat.send accepted the message.' };
  } catch (error) {
    return { success: false, failure: classifyGatewayException(error) };
  }
}

test('websocket LLM path sends chat.send and treats acceptance as success', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const result = await callOpenClawResponsesViaWebSocketForTest('Review this PR', async (method, params) => {
    calls.push({ method, params });
    return {
      success: true,
      result: {
        ok: true,
      },
    };
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.response, 'chat.send accepted the message.');
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'chat.send');
  assert.match(String(calls[0]?.params.text), /Review this PR/);
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
