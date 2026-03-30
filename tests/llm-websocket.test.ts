import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGatewayException } from '../lib/openclaw-gateway.ts';

async function callOpenClawResponsesViaWebSocketForTest(
  userMessage: string,
  callGatewayRpc: (method: string, params: Record<string, unknown>) => Promise<{ success: true; result: any } | { success: false; error: string }>,
): Promise<{ success: true; response: string } | { success: false; failure: ReturnType<typeof classifyGatewayException> }> {
  const sessionKey = 'main:jean-ci-review';

  try {
    const createResult = await callGatewayRpc('sessions.create', {
      key: sessionKey,
      label: 'Jean CI Review',
    });

    if (!createResult.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(createResult.error)),
      };
    }

    const sendResult = await callGatewayRpc('sessions.send', {
      key: sessionKey,
      message: `system prompt\n\n${userMessage}`,
      idempotencyKey: 'jean-ci-test',
    });

    if (!sendResult.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(sendResult.error)),
      };
    }

    const runId = typeof sendResult.result?.runId === 'string' ? sendResult.result.runId : null;
    if (!runId) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'sessions.send did not return a runId' },
      };
    }

    const waitResult = await callGatewayRpc('agent.wait', {
      runId,
      timeoutMs: 30_000,
    });

    if (!waitResult.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(waitResult.error)),
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
        failure: { errorType: 'unknown', retryable: false, error: waitResult.result.error || 'OpenClaw agent run failed' },
      };
    }

    const transcriptResult = await callGatewayRpc('sessions.get', {
      key: sessionKey,
      limit: 50,
    });

    if (!transcriptResult.success) {
      return {
        success: false,
        failure: classifyGatewayException(new Error(transcriptResult.error)),
      };
    }

    const lastAssistant = transcriptResult.result?.messages?.findLast?.((message: any) => message?.role === 'assistant');
    const responseText = typeof lastAssistant?.content === 'string' ? lastAssistant.content : null;
    if (!responseText) {
      return {
        success: false,
        failure: { errorType: 'unknown', retryable: false, error: 'No assistant response found in session transcript' },
      };
    }

    return { success: true, response: responseText };
  } catch (error) {
    return { success: false, failure: classifyGatewayException(error) };
  }
}

test('websocket LLM path waits for the run and then returns transcript text', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const result = await callOpenClawResponsesViaWebSocketForTest('Review this PR', async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.create') {
      return { success: true, result: { key: 'main:jean-ci-review' } };
    }
    if (method === 'sessions.send') {
      return { success: true, result: { runId: 'run-1', status: 'accepted', messageSeq: 1 } };
    }
    if (method === 'agent.wait') {
      return { success: true, result: { runId: 'run-1', status: 'ok' } };
    }
    if (method === 'sessions.get') {
      return { success: true, result: { messages: [{ role: 'assistant', content: 'Review complete' }] } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.response, 'Review complete');
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.method), ['sessions.create', 'sessions.send', 'agent.wait', 'sessions.get']);
  assert.deepEqual(calls[0]?.params, { key: 'main:jean-ci-review', label: 'Jean CI Review' });
  assert.deepEqual(calls[1]?.params, { key: 'main:jean-ci-review', message: 'system prompt\n\nReview this PR', idempotencyKey: 'jean-ci-test' });
  assert.deepEqual(calls[2]?.params, { runId: 'run-1', timeoutMs: 30000 });
  assert.deepEqual(calls[3]?.params, { key: 'main:jean-ci-review', limit: 50 });
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
