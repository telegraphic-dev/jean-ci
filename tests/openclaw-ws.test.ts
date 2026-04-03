import test from 'node:test';
import assert from 'node:assert/strict';
import { getWebSocketUrl, isWebSocketEnabled, callGatewayRpc } from '../lib/openclaw-ws.ts';

test('isWebSocketEnabled returns false when OPENCLAW_USE_WEBSOCKET is not set', () => {
  const original = process.env.OPENCLAW_USE_WEBSOCKET;
  delete process.env.OPENCLAW_USE_WEBSOCKET;

  assert.equal(isWebSocketEnabled(), false);

  if (original === undefined) {
    delete process.env.OPENCLAW_USE_WEBSOCKET;
  } else {
    process.env.OPENCLAW_USE_WEBSOCKET = original;
  }
});

test('getWebSocketUrl converts http URL to ws URL', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'http://localhost:18789';

  assert.equal(getWebSocketUrl(), 'ws://localhost:18789');

  if (original === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = original;
  }
});

test('getWebSocketUrl returns null when gateway URL is not set', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_URL;

  assert.equal(getWebSocketUrl(), null);

  if (original === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = original;
  }
});

test('getWebSocketUrl converts https URL to wss URL', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'https://gateway.example.com';

  assert.equal(getWebSocketUrl(), 'wss://gateway.example.com');

  if (original === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = original;
  }
});

test('getWebSocketUrl preserves websocket URLs', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;

  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.com';
  assert.equal(getWebSocketUrl(), 'ws://gateway.example.com');

  process.env.OPENCLAW_GATEWAY_URL = 'wss://gateway.example.com';
  assert.equal(getWebSocketUrl(), 'wss://gateway.example.com');

  if (original === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = original;
  }
});

test('getWebSocketUrl prefixes bare host values with ws', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'gateway.example.com:18789';

  assert.equal(getWebSocketUrl(), 'ws://gateway.example.com:18789');

  if (original === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = original;
  }
});

test('callGatewayRpc returns config error when websocket url or token is missing', async () => {
  const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;

  const result = await callGatewayRpc('sessions.list', { limit: 1 });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error, 'WebSocket URL or token not configured');
  }

  if (originalUrl === undefined) {
    delete process.env.OPENCLAW_GATEWAY_URL;
  } else {
    process.env.OPENCLAW_GATEWAY_URL = originalUrl;
  }

  if (originalToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  }
});
