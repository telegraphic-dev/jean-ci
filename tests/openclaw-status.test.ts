import test from 'node:test';
import assert from 'node:assert/strict';
import { getGatewayDashboardStatus } from '../lib/openclaw-status.ts';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('getGatewayDashboardStatus returns disabled when websocket is off', async () => {
  const prev = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'false';

  const status = await getGatewayDashboardStatus({
    isWebSocketEnabled: () => false,
  });
  assert.equal(status.status, 'disabled');
  assert.match(status.detail, /not enabled/i);

  restoreEnv('OPENCLAW_USE_WEBSOCKET', prev);
});

test('getGatewayDashboardStatus returns connected on successful probe', async () => {
  const prev = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'true';

  const status = await getGatewayDashboardStatus({
    isWebSocketEnabled: () => true,
    callGatewayRpc: async () => ({ success: true as const, result: { items: [] } }),
  });
  assert.equal(status.status, 'connected');
  assert.equal(status.color, 'green');

  restoreEnv('OPENCLAW_USE_WEBSOCKET', prev);
});

test('getGatewayDashboardStatus surfaces pairing required guidance and device id', async () => {
  const prev = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'true';

  const status = await getGatewayDashboardStatus({
    isWebSocketEnabled: () => true,
    callGatewayRpc: async () => ({
      success: false as const,
      error: 'Connect failed: pairing required',
      errorDetails: {
        code: 'PAIRING_REQUIRED',
        deviceId: 'dev_123',
        recommendedNextStep: 'review_auth_configuration',
      },
    }),
  });
  assert.equal(status.status, 'pairing_required');
  assert.equal(status.deviceId, 'dev_123');
  assert.match(status.guidance || '', /openclaw devices approve <requestId>/i);

  restoreEnv('OPENCLAW_USE_WEBSOCKET', prev);
});
