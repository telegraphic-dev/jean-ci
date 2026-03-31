import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGatewayException } from '../lib/openclaw-gateway.ts';

function normalizeSessionKeySegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalized || fallback;
}

function extractReviewContextMetadata(userMessage: string): {
  owner: string;
  repo: string;
  prNumber: string;
  promptName: string;
} {
  const ownerMatch = /(?:^|\n)Repository:\s*([^/\s]+)\/([^\s]+)/i.exec(userMessage);
  const prMatch = /(?:^|\n)PR\s*(?:Number)?:\s*#?(\d+)/i.exec(userMessage);
  const promptMatch = /(?:^|\n)Prompt\s*(?:File|Name)?:\s*(.+)$/im.exec(userMessage);

  return {
    owner: normalizeSessionKeySegment(ownerMatch?.[1], 'unknown-org'),
    repo: normalizeSessionKeySegment(ownerMatch?.[2], 'unknown-repo'),
    prNumber: normalizeSessionKeySegment(prMatch?.[1], 'unknown-pr'),
    promptName: normalizeSessionKeySegment(promptMatch?.[1], 'review'),
  };
}

function buildReviewSessionKey(userMessage: string): string {
  const metadata = extractReviewContextMetadata(userMessage);
  return `main:jean-ci:${metadata.owner}:${metadata.repo}:${metadata.prNumber}:${metadata.promptName}`;
}

async function callOpenClawResponsesViaWebSocketForTest(
  userMessage: string,
  callGatewayRpc: (method: string, params: Record<string, unknown>) => Promise<{ success: true; result: any } | { success: false; error: string }>,
): Promise<{ success: true; response: string } | { success: false; failure: ReturnType<typeof classifyGatewayException> }> {
  const sessionKey = buildReviewSessionKey(userMessage);

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
  } finally {
    try {
      await callGatewayRpc('sessions.delete', {
        key: sessionKey,
      });
    } catch {
      // cleanup is best-effort only
    }
  }
}

test('websocket LLM path waits for the run, returns transcript text, and deletes the session', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const userMessage = 'Repository: telegraphic-dev/jean-ci\nPR Number: 113\nPrompt File: e2e review.md\n\nReview this PR';
  const expectedKey = 'main:jean-ci:telegraphic-dev:jean-ci:113:e2e-review-md';

  const result = await callOpenClawResponsesViaWebSocketForTest(userMessage, async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.create') {
      return { success: true, result: { key: expectedKey } };
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
    if (method === 'sessions.delete') {
      return { success: true, result: { deleted: true } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.response, 'Review complete');
  }
  assert.deepEqual(calls.map((call) => call.method), ['sessions.create', 'sessions.send', 'agent.wait', 'sessions.get', 'sessions.delete']);
  assert.deepEqual(calls[0]?.params, { key: expectedKey, label: 'Jean CI Review' });
  assert.deepEqual(calls[1]?.params, { key: expectedKey, message: `system prompt\n\n${userMessage}`, idempotencyKey: 'jean-ci-test' });
  assert.deepEqual(calls[2]?.params, { runId: 'run-1', timeoutMs: 30000 });
  assert.deepEqual(calls[3]?.params, { key: expectedKey, limit: 50 });
  assert.deepEqual(calls[4]?.params, { key: expectedKey });
});

test('websocket LLM path still deletes the session when waiting fails', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const userMessage = 'Repository: telegraphic-dev/jean-ci\nPR Number: 114\n\nReview this PR';
  const expectedKey = 'main:jean-ci:telegraphic-dev:jean-ci:114:review';

  const result = await callOpenClawResponsesViaWebSocketForTest(userMessage, async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.create') {
      return { success: true, result: { key: expectedKey } };
    }
    if (method === 'sessions.send') {
      return { success: true, result: { runId: 'run-2', status: 'accepted', messageSeq: 1 } };
    }
    if (method === 'agent.wait') {
      return { success: false, error: 'Connection timeout after 10000ms' };
    }
    if (method === 'sessions.delete') {
      return { success: true, result: { deleted: true } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.failure.errorType, 'gateway');
    assert.equal(result.failure.retryable, true);
  }
  assert.deepEqual(calls.map((call) => call.method), ['sessions.create', 'sessions.send', 'agent.wait', 'sessions.delete']);
  assert.deepEqual(calls.at(-1)?.params, { key: expectedKey });
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
