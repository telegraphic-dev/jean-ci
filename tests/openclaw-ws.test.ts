import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebSocketEnabled,
  getWebSocketUrl,
} from '../lib/openclaw-ws.ts';

test('isWebSocketEnabled returns false when OPENCLAW_USE_WEBSOCKET is not set', () => {
  const original = process.env.OPENCLAW_USE_WEBSOCKET;
  delete process.env.OPENCLAW_USE_WEBSOCKET;
  
  assert.equal(isWebSocketEnabled(), false);
  
  process.env.OPENCLAW_USE_WEBSOCKET = original;
});

test('isWebSocketEnabled returns false when OPENCLAW_USE_WEBSOCKET is "false"', () => {
  const original = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'false';
  
  assert.equal(isWebSocketEnabled(), false);
  
  process.env.OPENCLAW_USE_WEBSOCKET = original;
});

test('isWebSocketEnabled returns true when OPENCLAW_USE_WEBSOCKET is "true"', () => {
  const original = process.env.OPENCLAW_USE_WEBSOCKET;
  process.env.OPENCLAW_USE_WEBSOCKET = 'true';
  
  assert.equal(isWebSocketEnabled(), true);
  
  process.env.OPENCLAW_USE_WEBSOCKET = original;
});

test('getWebSocketUrl returns null when OPENCLAW_GATEWAY_URL is not set', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_URL;
  
  assert.equal(getWebSocketUrl(), null);
  
  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl converts http:// to ws://', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'http://localhost:18789';
  
  assert.equal(getWebSocketUrl(), 'ws://localhost:18789');
  
  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl converts https:// to wss://', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'https://gateway.example.com';
  
  assert.equal(getWebSocketUrl(), 'wss://gateway.example.com');
  
  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl preserves ws:// URLs', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'ws://localhost:18789';
  
  assert.equal(getWebSocketUrl(), 'ws://localhost:18789');
  
  process.env.OPENCLAW_GATEWAY_URL = original;
});

test('getWebSocketUrl adds ws:// prefix to bare hosts', () => {
  const original = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'localhost:18789';
  
  assert.equal(getWebSocketUrl(), 'ws://localhost:18789');
  
  process.env.OPENCLAW_GATEWAY_URL = original;
});
