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

  const getDebugInfo = () => ({
    websocketEnabled: false,
    gatewayUrl: 'ws://gateway.example.com',
    identityPath: '/data/device.json',
    identityExists: false,
    tokenStorePath: '/data/tokens.json',
    tokenStoreExists: false,
    deviceId: 'dev_disabled',
    role: 'operator',
    scopes: ['operator.read'],
    hasSharedToken: true,
    hasStoredDeviceToken: false,
    storedDeviceTokenUpdatedAtMs: null,
  });

  const status = await getGatewayDashboardStatus({
    isWebSocketEnabled: () => false,
    getDebugInfo,
    getTokenAdminState: async () => ({
      deviceId: 'dev_disabled',
      requestedRole: 'operator',
      requestedScopes: ['operator.read', 'operator.write', 'operator.admin'],
      storedRole: null,
      storedScopes: [],
      hasStoredToken: false,
      storedTokenUpdatedAtMs: null,
      tokenStoreExists: false,
    }),
  });
  assert.equal(status.status, 'disabled');
  assert.match(status.detail, /not enabled/i);
  assert.equal(status.deviceId, 'dev_disabled');
  assert.equal(status.debug.identityPath, '/data/device.json');

  restoreEnv('OPENCLAW_USE_WEBSOCKET', prev);
});

test('getGatewayDashboardStatus returns connected on successful probe', async () => {
  const prev = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'true';

  const status = await getGatewayDashboardStatus({
    isWebSocketEnabled: () => true,
    callGatewayRpc: async () => ({ success: true as const, result: { items: [] } }),
    getDebugInfo: () => ({
      websocketEnabled: true,
      gatewayUrl: 'ws://gateway.example.com',
      identityPath: '/data/device.json',
      identityExists: true,
      tokenStorePath: '/data/tokens.json',
      tokenStoreExists: true,
      deviceId: 'dev_connected',
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.admin'],
      hasSharedToken: true,
      hasStoredDeviceToken: true,
      storedDeviceTokenUpdatedAtMs: 123,
    }),
    getTokenAdminState: async () => ({
      deviceId: 'dev_connected',
      requestedRole: 'operator',
      requestedScopes: ['operator.read', 'operator.write', 'operator.admin'],
      storedRole: 'operator',
      storedScopes: ['operator.read', 'operator.write', 'operator.admin'],
      hasStoredToken: true,
      storedTokenUpdatedAtMs: 123,
      tokenStoreExists: true,
    }),
    now: (() => {
      let t = 100;
      return () => (t += 7);
    })(),
  });
  assert.equal(status.status, 'connected');
  assert.equal(status.color, 'green');
  assert.equal(status.deviceId, 'dev_connected');
  assert.equal(status.latencyMs, 7);
  assert.equal(status.debug.hasStoredDeviceToken, true);

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
    getDebugInfo: () => ({
      websocketEnabled: true,
      gatewayUrl: 'ws://gateway.example.com',
      identityPath: '/data/device.json',
      identityExists: true,
      tokenStorePath: '/data/tokens.json',
      tokenStoreExists: false,
      deviceId: 'dev_debug',
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.admin'],
      hasSharedToken: true,
      hasStoredDeviceToken: false,
      storedDeviceTokenUpdatedAtMs: null,
    }),
    getTokenAdminState: async () => ({
      deviceId: 'dev_debug',
      requestedRole: 'operator',
      requestedScopes: ['operator.read', 'operator.write', 'operator.admin'],
      storedRole: null,
      storedScopes: [],
      hasStoredToken: false,
      storedTokenUpdatedAtMs: null,
      tokenStoreExists: false,
    }),
    now: (() => {
      let t = 200;
      return () => (t += 11);
    })(),
  });
  assert.equal(status.status, 'pairing_required');
  assert.equal(status.deviceId, 'dev_123');
  assert.equal(status.latencyMs, 11);
  assert.equal(status.debug.tokenStoreExists, false);
  assert.match(status.guidance || '', /openclaw devices approve <requestId>/i);

  restoreEnv('OPENCLAW_USE_WEBSOCKET', prev);
});
