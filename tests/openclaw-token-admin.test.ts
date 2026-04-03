import test from 'node:test';
import assert from 'node:assert/strict';
import { getGatewayTokenAdminState, revokeStoredGatewayToken } from '../lib/openclaw-token-admin.ts';

test('getGatewayTokenAdminState reports requested admin scopes and stored token scopes', async () => {
  const state = await getGatewayTokenAdminState({
    getDebugInfo: async () => ({
      websocketEnabled: true,
      gatewayUrl: 'ws://gateway.example.com',
      identityPath: 'postgres:identity',
      identityExists: true,
      tokenStorePath: 'postgres:token-store',
      tokenStoreExists: true,
      deviceId: 'dev-123',
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.admin'],
      hasSharedToken: true,
      hasStoredDeviceToken: true,
      storedDeviceTokenUpdatedAtMs: 321,
    }),
    readStore: async () => ({
      version: 1,
      deviceId: 'dev-123',
      tokens: {
        operator: {
          token: 'secret-token',
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          updatedAtMs: 321,
        },
      },
    }),
  });

  assert.deepEqual(state.requestedScopes, ['operator.read', 'operator.write', 'operator.admin']);
  assert.deepEqual(state.storedScopes, ['operator.read', 'operator.write', 'operator.admin']);
  assert.equal(state.hasStoredToken, true);
  assert.equal(state.storedTokenUpdatedAtMs, 321);
});

test('revokeStoredGatewayToken removes cached operator token', async () => {
  let stored = {
    version: 1,
    deviceId: 'dev-123',
    tokens: {
      operator: {
        token: 'secret-token',
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
        updatedAtMs: 321,
      },
    },
  } as const;

  const state = await revokeStoredGatewayToken({
    getDebugInfo: async () => ({
      websocketEnabled: true,
      gatewayUrl: 'ws://gateway.example.com',
      identityPath: 'postgres:identity',
      identityExists: true,
      tokenStorePath: 'postgres:token-store',
      tokenStoreExists: true,
      deviceId: 'dev-123',
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.admin'],
      hasSharedToken: true,
      hasStoredDeviceToken: true,
      storedDeviceTokenUpdatedAtMs: 321,
    }),
    readStore: async () => stored as any,
    writeStore: async (next) => {
      stored = next as any;
    },
  });

  assert.equal(state.hasStoredToken, false);
  assert.deepEqual(state.storedScopes, []);
  assert.equal((stored as any).tokens.operator, undefined);
});
