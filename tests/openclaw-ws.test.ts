import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAndCallGatewayRpc, getWebSocketUrl, isWebSocketEnabled } from '../lib/openclaw-ws.ts';

class FakeWebSocket {
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  sent: any[] = [];
  closed = false;

  on(event: string, listener: (...args: any[]) => void) {
    const arr = this.handlers.get(event) || [];
    arr.push(listener);
    this.handlers.set(event, arr);
  }

  async emit(event: string, ...args: any[]) {
    for (const listener of this.handlers.get(event) || []) {
      await listener(...args);
    }
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
  }
}

test('isWebSocketEnabled returns false when OPENCLAW_USE_WEBSOCKET is not set', () => {
  const original = process.env.OPENCLAW_USE_WEBSOCKET;
  delete process.env.OPENCLAW_USE_WEBSOCKET;

  assert.equal(isWebSocketEnabled(), false);

  process.env.OPENCLAW_USE_WEBSOCKET = original;
});

test('getWebSocketUrl converts http URL to ws URL', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'http://localhost:18789';

  assert.equal(getWebSocketUrl(), 'ws://localhost:18789');

  process.env.OPENCLAW_GATEWAY_URL = original;
});


test('getWebSocketUrl returns null when gateway URL is not set', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_URL;

  assert.equal(getWebSocketUrl(), null);

  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl converts https URL to wss URL', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'https://gateway.example.com';

  assert.equal(getWebSocketUrl(), 'wss://gateway.example.com');

  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl preserves websocket URLs', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;

  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.com';
  assert.equal(getWebSocketUrl(), 'ws://gateway.example.com');

  process.env.OPENCLAW_GATEWAY_URL = 'wss://gateway.example.com';
  assert.equal(getWebSocketUrl(), 'wss://gateway.example.com');

  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl prefixes bare host values with ws', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'gateway.example.com:18789';

  assert.equal(getWebSocketUrl(), 'ws://gateway.example.com:18789');

  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('connectAndCallGatewayRpc performs challenge-based device auth and stores returned device token', async () => {
  const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.com';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'shared-token';

  const fake = new FakeWebSocket();
  let stored: any = null;

  const promise = connectAndCallGatewayRpc<{ ok: true }>('sessions.list', { limit: 1 }, {
    createWebSocket: () => fake as any,
    loadIdentity: () => ({
      deviceId: 'device-1',
      publicKeyPem: 'PUBLIC-PEM',
      privateKeyPem: 'PRIVATE-PEM',
    }),
    readDeviceTokenStore: () => null,
    writeDeviceTokenStore: (value) => {
      stored = value;
    },
    clearStoredDeviceToken: () => {},
    now: () => 1234567890,
    randomId: () => 'req-1',
    signPayload: (_key, payload) => `signed:${payload}`,
    publicKeyFromPem: () => 'pubkey-raw',
    connectTimeoutMs: 1000,
    challengeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await fake.emit('open');
  await fake.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.sent[0].method, 'connect');
  assert.equal(fake.sent[0].params.auth.token, 'shared-token');
  assert.equal(fake.sent[0].params.device.nonce, 'nonce-1');
  assert.equal(fake.sent[0].params.device.publicKey, 'pubkey-raw');
  assert.match(fake.sent[0].params.device.signature, /^signed:v2\|device-1\|gateway-client\|backend\|operator\|operator.read,operator.write,operator.admin\|1234567890\|shared-token\|nonce-1$/);

  await fake.emit('message', JSON.stringify({ type: 'hello-ok', auth: { deviceToken: 'device-token-1', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'] } }));

  assert.equal(fake.sent[1].method, 'sessions.list');
  assert.deepEqual(fake.sent[1].params, { limit: 1 });

  await fake.emit('message', JSON.stringify({ type: 'res', id: 'req-1', ok: true, payload: { ok: true } }));

  const result = await promise;
  assert.equal(result.success, true);
  assert.equal(stored.deviceId, 'device-1');
  assert.equal(stored.tokens.operator.token, 'device-token-1');

  process.env.OPENCLAW_GATEWAY_URL = originalUrl;
  process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
});

test('connectAndCallGatewayRpc retries once with stored device token on AUTH_TOKEN_MISMATCH', async () => {
  const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.com';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'shared-token';

  const fakes = [new FakeWebSocket(), new FakeWebSocket()];
  let createCount = 0;

  const promise = connectAndCallGatewayRpc<{ value: number }>('sessions.list', { limit: 2 }, {
    createWebSocket: () => fakes[createCount++] as any,
    loadIdentity: () => ({
      deviceId: 'device-1',
      publicKeyPem: 'PUBLIC-PEM',
      privateKeyPem: 'PRIVATE-PEM',
    }),
    readDeviceTokenStore: () => ({
      version: 1,
      deviceId: 'device-1',
      tokens: {
        operator: {
          token: 'stored-device-token',
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          updatedAtMs: 1,
        },
      },
    }),
    writeDeviceTokenStore: () => {},
    clearStoredDeviceToken: () => {},
    now: () => 1234567890,
    randomId: () => 'req-1',
    signPayload: (_key, payload) => `signed:${payload}`,
    publicKeyFromPem: () => 'pubkey-raw',
    connectTimeoutMs: 1000,
    challengeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await fakes[0].emit('open');
  await fakes[0].emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
  await fakes[0].emit('message', JSON.stringify({
    type: 'res',
    id: 'connect-1',
    ok: false,
    error: {
      message: 'token mismatch',
      details: {
        code: 'AUTH_TOKEN_MISMATCH',
        canRetryWithDeviceToken: true,
        recommendedNextStep: 'retry_with_device_token',
      },
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  await fakes[1].emit('open');
  await fakes[1].emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-2' } }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakes[1].sent.length, 1);
  assert.equal(fakes[1].sent[0].params.auth.token, 'shared-token');
  assert.equal(fakes[1].sent[0].params.auth.deviceToken, 'stored-device-token');

  await fakes[1].emit('message', JSON.stringify({ type: 'hello-ok', auth: { deviceToken: 'rotated-device-token', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'] } }));
  await fakes[1].emit('message', JSON.stringify({ type: 'res', id: 'req-1', ok: true, payload: { value: 42 } }));

  const result = await promise;
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.result.value, 42);
  }

  process.env.OPENCLAW_GATEWAY_URL = originalUrl;
  process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
});

test('connectAndCallGatewayRpc clears stored device token on AUTH_DEVICE_TOKEN_MISMATCH', async () => {
  const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.com';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'shared-token';

  const fakes = [new FakeWebSocket(), new FakeWebSocket()];
  let createCount = 0;
  const cleared: string[] = [];

  const promise = connectAndCallGatewayRpc<{ value: number }>('sessions.list', { limit: 2 }, {
    createWebSocket: () => fakes[createCount++] as any,
    loadIdentity: () => ({
      deviceId: 'device-1',
      publicKeyPem: 'PUBLIC-PEM',
      privateKeyPem: 'PRIVATE-PEM',
    }),
    readDeviceTokenStore: () => ({
      version: 1,
      deviceId: 'device-1',
      tokens: {
        operator: {
          token: 'stored-device-token',
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          updatedAtMs: 1,
        },
      },
    }),
    writeDeviceTokenStore: () => {},
    clearStoredDeviceToken: (deviceId, role) => {
      cleared.push(`${deviceId}:${role}`);
    },
    now: () => 1234567890,
    randomId: () => 'req-1',
    signPayload: (_key, payload) => `signed:${payload}`,
    publicKeyFromPem: () => 'pubkey-raw',
    connectTimeoutMs: 1000,
    challengeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await fakes[0].emit('open');
  await fakes[0].emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
  await fakes[0].emit('message', JSON.stringify({
    type: 'res',
    id: 'connect-1',
    ok: false,
    error: {
      message: 'token mismatch',
      details: {
        code: 'AUTH_TOKEN_MISMATCH',
        canRetryWithDeviceToken: true,
      },
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  await fakes[1].emit('open');
  await fakes[1].emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-2' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fakes[1].sent.length, 1);
  assert.equal(fakes[1].sent[0].params.auth.deviceToken, 'stored-device-token');
  await fakes[1].emit('message', JSON.stringify({
    type: 'res',
    id: 'connect-1',
    ok: false,
    error: {
      message: 'device token mismatch',
      details: {
        code: 'AUTH_DEVICE_TOKEN_MISMATCH',
      },
    },
  }));

  const result = await promise;
  assert.equal(result.success, false);
  assert.deepEqual(cleared, ['device-1:operator']);

  process.env.OPENCLAW_GATEWAY_URL = originalUrl;
  process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
});
