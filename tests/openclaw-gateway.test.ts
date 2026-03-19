import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGatewayException,
  classifyGatewayHttpFailure,
  getRetryDelayMs,
  runWithExponentialRetry,
} from '../lib/openclaw-gateway.ts';

test('classifyGatewayHttpFailure marks transient HTTP failures as retryable gateway errors', () => {
  const failure = classifyGatewayHttpFailure(503, 'upstream timeout');

  assert.equal(failure.errorType, 'gateway');
  assert.equal(failure.retryable, true);
});

test('classifyGatewayHttpFailure marks non-transient HTTP failures as unknown non-retryable', () => {
  const failure = classifyGatewayHttpFailure(401, 'invalid token');

  assert.equal(failure.errorType, 'unknown');
  assert.equal(failure.retryable, false);
});

test('classifyGatewayException detects network/timeouts as retryable gateway errors', () => {
  const failure = classifyGatewayException(new Error('fetch failed: ECONNRESET'));

  assert.equal(failure.errorType, 'gateway');
  assert.equal(failure.retryable, true);
});

test('getRetryDelayMs uses exponential growth', () => {
  assert.equal(getRetryDelayMs(1, 100), 100);
  assert.equal(getRetryDelayMs(2, 100), 200);
  assert.equal(getRetryDelayMs(3, 100), 400);
});

test('runWithExponentialRetry retries retryable failures until success', async () => {
  let attempts = 0;
  const result = await runWithExponentialRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      return {
        success: false as const,
        failure: { errorType: 'gateway' as const, retryable: true, error: 'timeout' },
      };
    }

    return { success: true as const, value: 'ok' };
  }, {
    maxAttempts: 3,
    retryBaseMs: 0,
    sleep: async () => {},
  });

  assert.equal(attempts, 3);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.value, 'ok');
  }
});

test('runWithExponentialRetry stops immediately for non-retryable failures', async () => {
  let attempts = 0;
  const result = await runWithExponentialRetry(async () => {
    attempts += 1;
    return {
      success: false as const,
      failure: { errorType: 'unknown' as const, retryable: false, error: 'bad request' },
    };
  }, {
    maxAttempts: 3,
    retryBaseMs: 0,
    sleep: async () => {},
  });

  assert.equal(attempts, 1);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.failure.errorType, 'unknown');
    assert.equal(result.attempts, 1);
  }
});
