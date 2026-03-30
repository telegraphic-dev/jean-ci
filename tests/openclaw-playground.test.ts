import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listGatewayMethodPrivileges,
  listGatewayPlaygroundOperations,
  resolveGatewayPlaygroundPrivileges,
  resolveRequiredOperatorScopeForMethod,
  runGatewayPlaygroundProbe,
} from '../lib/openclaw-playground.ts';

test('listGatewayMethodPrivileges exposes OpenClaw method scope mappings', () => {
  const methods = listGatewayMethodPrivileges();
  assert.equal(methods.some((entry) => entry.method === 'sessions.list' && entry.requiredScope === 'operator.read'), true);
  assert.equal(methods.some((entry) => entry.method === 'chat.send' && entry.requiredScope === 'operator.write'), true);
  assert.equal(methods.some((entry) => entry.method === 'sessions.delete' && entry.requiredScope === 'operator.admin'), true);
  assert.equal(methods.some((entry) => entry.method === 'config.*' && entry.requiredScope === 'operator.admin'), true);
});

test('resolveRequiredOperatorScopeForMethod follows direct and fallback mappings', () => {
  assert.deepEqual(resolveRequiredOperatorScopeForMethod('sessions.list'), {
    requiredScope: 'operator.read',
    source: 'openclaw-method-scopes',
  });
  assert.deepEqual(resolveRequiredOperatorScopeForMethod('config.patch'), {
    requiredScope: 'operator.admin',
    source: 'openclaw-admin-prefix-fallback',
  });
  assert.deepEqual(resolveRequiredOperatorScopeForMethod('chat.send'), {
    requiredScope: 'operator.write',
    source: 'openclaw-method-scopes',
  });
});

test('listGatewayPlaygroundOperations exposes recommended privileges', () => {
  const operations = listGatewayPlaygroundOperations();
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.find((operation) => operation.mode === 'sessions_list')?.requiredScopes, ['operator.read']);
  assert.deepEqual(operations.find((operation) => operation.mode === 'chat_send')?.requiredScopes, ['operator.write']);
});

test('resolveGatewayPlaygroundPrivileges falls back to operation defaults', () => {
  const resolved = resolveGatewayPlaygroundPrivileges({ mode: 'chat_send' });
  assert.equal(resolved.role, 'operator');
  assert.deepEqual(resolved.scopes, ['operator.write']);
  assert.deepEqual(resolved.recommendedScopes, ['operator.write']);
});

test('runGatewayPlaygroundProbe runs sessions.list probe', async () => {
  const result = await runGatewayPlaygroundProbe(
    { mode: 'sessions_list', role: 'operator', scopes: ['operator.read'] },
    {
      callGatewayRpc: async (method, params, authOverrides) => {
        assert.equal(method, 'sessions.list');
        assert.deepEqual(params, { limit: 3 });
        assert.deepEqual(authOverrides, { role: 'operator', scopes: ['operator.read'] });
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
  assert.equal(result.selectedRole, 'operator');
  assert.deepEqual(result.selectedScopes, ['operator.read']);
  assert.deepEqual(result.result, { items: [{ id: 1 }] });
});

test('runGatewayPlaygroundProbe runs chat session flow for chat.send probe', async () => {
  const calls: Array<{ method: string; params: any; authOverrides: any }> = [];

  const result = await runGatewayPlaygroundProbe(
    { mode: 'chat_send', prompt: 'Say OK', sessionKey: 'main:gateway-playground' },
    {
      callGatewayRpc: async (method, params, authOverrides) => {
        calls.push({ method, params, authOverrides });
        if (method === 'sessions.create') {
          return { success: true as const, result: { key: 'main:gateway-playground' } };
        }
        if (method === 'chat.send') {
          return { success: true as const, result: { runId: 'run-1', status: 'accepted' } };
        }
        if (method === 'chat.history') {
          return { success: true as const, result: { items: [{ role: 'assistant', content: 'OK' }] } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
      now: (() => {
        let t = 100;
        return () => (t += 9);
      })(),
      randomId: () => 'idem-1',
    },
  );

  assert.equal(calls[0]?.method, 'sessions.create');
  assert.deepEqual(calls[0]?.params, { key: 'main:gateway-playground', label: 'Gateway Playground' });
  assert.equal(calls[1]?.method, 'chat.send');
  assert.deepEqual(calls[1]?.params, { sessionKey: 'main:gateway-playground', message: 'Say OK', idempotencyKey: 'idem-1' });
  assert.equal(calls[2]?.method, 'chat.history');
  assert.deepEqual(calls[2]?.params, { sessionKey: 'main:gateway-playground', limit: 10 });
  assert.deepEqual(calls[1]?.authOverrides, { role: 'operator', scopes: ['operator.write'] });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'chat_send');
  assert.equal(result.latencyMs, 9);
  assert.deepEqual(result.recommendedScopes, ['operator.write']);
  assert.equal(result.sessionKey, 'main:gateway-playground');
  assert.deepEqual(result.result, { items: [{ role: 'assistant', content: 'OK' }] });
});
