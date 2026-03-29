import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGatewayAuthGuidance,
  classifyGatewayException,
  classifyGatewayHttpFailure,
  getRetryDelayMs,
  parseGatewayAuthRecoveryHint,
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

test('classifyGatewayException treats pairing/auth failures as gateway errors but not retryable', () => {
  const failure = classifyGatewayException(new Error('Connect failed: pairing required {"errorDetails":{"code":"PAIRING_REQUIRED"}}'));

  assert.equal(failure.errorType, 'gateway');
  assert.equal(failure.retryable, false);
  assert.match(failure.error, /pairing required/i);
});

test('parseGatewayAuthRecoveryHint extracts structured auth details', () => {
  const hint = parseGatewayAuthRecoveryHint(JSON.stringify({
    error: {
      details: {
        code: 'AUTH_TOKEN_MISMATCH',
        canRetryWithDeviceToken: true,
        recommendedNextStep: 'retry_with_device_token',
      },
    },
  }));

  assert.deepEqual(hint, {
    code: 'AUTH_TOKEN_MISMATCH',
    canRetryWithDeviceToken: true,
    recommendedNextStep: 'retry_with_device_token',
  });
});

test('parseGatewayAuthRecoveryHint extracts optional device id', () => {
  const hint = parseGatewayAuthRecoveryHint(JSON.stringify({
    error: {
      details: {
        code: 'PAIRING_REQUIRED',
        deviceId: 'dev_123',
      },
    },
  }));

  assert.deepEqual(hint, {
    code: 'PAIRING_REQUIRED',
    deviceId: 'dev_123',
  });
});

test('buildGatewayAuthGuidance renders retry guidance for token mismatch', () => {
  const guidance = buildGatewayAuthGuidance({
    code: 'AUTH_TOKEN_MISMATCH',
    canRetryWithDeviceToken: true,
    recommendedNextStep: 'retry_with_device_token',
  });

  assert.match(guidance || '', /retrying once with the cached device token/i);
});

test('buildGatewayAuthGuidance renders pairing guidance', () => {
  const guidance = buildGatewayAuthGuidance({
    code: 'PAIRING_REQUIRED',
    deviceId: 'dev_123',
    recommendedNextStep: 'review_auth_configuration',
  });

  assert.match(guidance || '', /paired before it can review prs/i);
  assert.match(guidance || '', /openclaw devices list/i);
  assert.match(guidance || '', /openclaw devices approve <requestId>/i);
  assert.match(guidance || '', /openclaw devices rotate --device <deviceId>/i);
  assert.match(guidance || '', /dev_123/i);
  assert.match(guidance || '', /review jean-ci gateway auth configuration/i);
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
