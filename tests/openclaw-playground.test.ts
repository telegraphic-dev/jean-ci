import test from 'node:test';
import assert from 'node:assert/strict';
import { runGatewayPlaygroundProbe } from '../lib/openclaw-playground.ts';

test('runGatewayPlaygroundProbe runs sessions.list probe', async () => {
  const result = await runGatewayPlaygroundProbe(
    { mode: 'sessions_list' },
    {
      callGatewayRpc: async (method, params) => {
        assert.equal(method, 'sessions.list');
        assert.deepEqual(params, { limit: 3 });
        return { success: true as const, result: { items: [{ id: 1 }] } };
      },
      now: (() => {
        let t = 10;
        return () => (t += 5);
      })(),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'sessions_list');
  assert.equal(result.latencyMs, 5);
  assert.deepEqual(result.result, { items: [{ id: 1 }] });
});

test('runGatewayPlaygroundProbe runs responses.create probe', async () => {
  const result = await runGatewayPlaygroundProbe(
    { mode: 'responses_create', prompt: 'Say OK' },
    {
      callGatewayRpc: async (method, params) => {
        assert.equal(method, 'responses.create');
        assert.equal((params as any).model, process.env.OPENCLAW_RESPONSES_MODEL || 'openclaw');
        assert.equal((params as any).input[0].content, 'Say OK');
        return { success: true as const, result: { output_text: 'OK' } };
      },
      now: (() => {
        let t = 100;
        return () => (t += 9);
      })(),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'responses_create');
  assert.equal(result.latencyMs, 9);
  assert.deepEqual(result.result, { output_text: 'OK' });
});
