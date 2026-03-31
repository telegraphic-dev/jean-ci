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

function buildReviewSessionKey(metadata: {
  owner?: string;
  repo?: string;
  prNumber?: string | number;
  promptName?: string;
} = {}): string {
  return `main:jean-ci:${normalizeSessionKeySegment(metadata.owner, 'unknown-org')}:${normalizeSessionKeySegment(metadata.repo, 'unknown-repo')}:${normalizeSessionKeySegment(metadata.prNumber?.toString(), 'unknown-pr')}:${normalizeSessionKeySegment(metadata.promptName, 'review')}`;
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

async function callOpenClawResponsesViaWebSocketForTest(
  userMessage: string,
  metadata: { owner?: string; repo?: string; prNumber?: string | number; promptName?: string } | undefined,
  callGatewayRpc: (method: string, params: Record<string, unknown>) => Promise<{ success: true; result: any } | { success: false; error: string; errorDetails?: unknown }>,
  logger: Pick<typeof console, 'warn'> = console,
): Promise<{ success: true; response: string } | { success: false; failure: ReturnType<typeof classifyGatewayException> }> {
  const sessionKey = buildReviewSessionKey(metadata);

  try {
    const createResult = await callGatewayRpc('sessions.create', {
      key: sessionKey,
      label: buildReviewSessionLabel(sessionKey),
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
      const deleteResult = await callGatewayRpc('sessions.delete', {
        key: sessionKey,
      });

      if (!deleteResult.success) {
        if (isOperatorAdminMissingScopeError(deleteResult)) {
          logger.warn('Skipped OpenClaw review session deletion because caller lacks operator.admin', {
            sessionKey,
            error: deleteResult.error,
          });
        } else {
          logger.warn('Failed to delete OpenClaw review session', {
            sessionKey,
            error: deleteResult.error,
            errorDetails: deleteResult.errorDetails,
          });
        }
      }
    } catch {
      // cleanup is best-effort only
    }
  }
}

test('websocket LLM path waits for the run, returns transcript text, and deletes the session', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const userMessage = 'Review this PR';
  const metadata = { owner: 'telegraphic-dev', repo: 'jean-ci', prNumber: 113, promptName: 'e2e review.md' };
  const expectedKey = 'main:jean-ci:telegraphic-dev:jean-ci:113:e2e-review-md';

  const result = await callOpenClawResponsesViaWebSocketForTest(userMessage, metadata, async (method, params) => {
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
  assert.deepEqual(calls[0]?.params, { key: expectedKey, label: `Jean CI Review · ${expectedKey}` });
  assert.deepEqual(calls[1]?.params, { key: expectedKey, message: `system prompt\n\n${userMessage}`, idempotencyKey: 'jean-ci-test' });
  assert.deepEqual(calls[2]?.params, { runId: 'run-1', timeoutMs: 30000 });
  assert.deepEqual(calls[3]?.params, { key: expectedKey, limit: 50 });
  assert.deepEqual(calls[4]?.params, { key: expectedKey });
});

test('websocket LLM path still deletes the session when waiting fails', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const userMessage = 'Review this PR';
  const metadata = { owner: 'telegraphic-dev', repo: 'jean-ci', prNumber: 114, promptName: 'review' };
  const expectedKey = 'main:jean-ci:telegraphic-dev:jean-ci:114:review';

  const result = await callOpenClawResponsesViaWebSocketForTest(userMessage, metadata, async (method, params) => {
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

test('websocket LLM path tolerates missing operator.admin during best-effort delete', async () => {
  const warnings: Array<{ message?: string; meta?: unknown }> = [];
  const logger = {
    warn(message: string, meta?: unknown) {
      warnings.push({ message, meta });
    },
  };

  const result = await callOpenClawResponsesViaWebSocketForTest(
    'Review this PR',
    { owner: 'telegraphic-dev', repo: 'jean-ci', prNumber: 115, promptName: 'review' },
    async (method) => {
      if (method === 'sessions.create') {
        return { success: true, result: { key: 'main:jean-ci:telegraphic-dev:jean-ci:115:review' } };
      }
      if (method === 'sessions.send') {
        return { success: true, result: { runId: 'run-3', status: 'accepted', messageSeq: 1 } };
      }
      if (method === 'agent.wait') {
        return { success: true, result: { runId: 'run-3', status: 'ok' } };
      }
      if (method === 'sessions.get') {
        return { success: true, result: { messages: [{ role: 'assistant', content: 'Review complete' }] } };
      }
      if (method === 'sessions.delete') {
        return {
          success: false,
          error: 'INVALID_REQUEST: missing scope: operator.admin',
          errorDetails: { code: 'INVALID_REQUEST', requiredScope: 'operator.admin' },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    },
    logger,
  );

  assert.equal(result.success, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, 'Skipped OpenClaw review session deletion because caller lacks operator.admin');
});

test('websocket LLM path classifies RPC transport failures as gateway errors', async () => {
  const result = await callOpenClawResponsesViaWebSocketForTest('Review this PR', undefined, async () => ({
    success: false,
    error: 'Connection timeout after 10000ms',
  }));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.failure.errorType, 'gateway');
    assert.equal(result.failure.retryable, true);
  }
});
