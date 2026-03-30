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
  assert.deepEqual(resolveRequiredOperatorScopeForMethod('responses.create'), {
    requiredScope: 'operator.admin',
    source: 'openclaw-admin-prefix-fallback',
  });
});

test('listGatewayPlaygroundOperations exposes recommended privileges', () => {
  const operations = listGatewayPlaygroundOperations();
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.find((operation) => operation.mode === 'sessions_list')?.requiredScopes, ['operator.read']);
  assert.deepEqual(operations.find((operation) => operation.mode === 'responses_create')?.requiredScopes, ['operator.admin']);
});

test('resolveGatewayPlaygroundPrivileges falls back to operation defaults', () => {
  const resolved = resolveGatewayPlaygroundPrivileges({ mode: 'responses_create' });
  assert.equal(resolved.role, 'operator');
  assert.deepEqual(resolved.scopes, ['operator.admin']);
  assert.deepEqual(resolved.recommendedScopes, ['operator.admin']);
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

test('runGatewayPlaygroundProbe runs responses.create probe', async () => {
  const result = await runGatewayPlaygroundProbe(
    { mode: 'responses_create', prompt: 'Say OK' },
    {
      callGatewayRpc: async (method, params, authOverrides) => {
        assert.equal(method, 'responses.create');
        assert.equal((params as any).model, process.env.OPENCLAW_RESPONSES_MODEL || 'openclaw');
        assert.equal((params as any).input[0].content, 'Say OK');
        assert.deepEqual(authOverrides, { role: 'operator', scopes: ['operator.admin'] });
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
  assert.deepEqual(result.recommendedScopes, ['operator.admin']);
  assert.deepEqual(result.result, { output_text: 'OK' });
});
