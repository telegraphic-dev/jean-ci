import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoSessionSeedPrompt } from '../lib/repo-feature-session-prompt.ts';
import { createRepoFeatureSession, type RepoFeatureSessionDeps } from '../lib/repo-feature-sessions.ts';

test('buildRepoSessionSeedPrompt binds the session to a repository and PR backlink rules', () => {
  const prompt = buildRepoSessionSeedPrompt('telegraphic-dev/jean-ci');

  assert.match(prompt, /permanently bound to repository telegraphic-dev\/jean-ci/i);
  assert.match(prompt, /oc-session:SESSION_KEY/);
  assert.match(prompt, /visible Jean-CI session backlink/i);
  assert.match(prompt, /PR review and CI feedback will be injected back/i);
});

test('createRepoFeatureSession cleans up gateway session when seeding fails', async () => {
  const rpcCalls: Array<{ method: string; payload: unknown }> = [];
  let upsertCalls = 0;
  const deps: RepoFeatureSessionDeps = {
    callGatewayRpc: async (method: string, payload?: unknown) => {
      rpcCalls.push({ method, payload });

      if (method === 'sessions.create') {
        return { success: true, result: { key: 'created-key', url: 'https://example.test/session/1' } };
      }
      if (method === 'sessions.send') {
        return { success: false, error: 'send failed' };
      }
      if (method === 'sessions.delete') {
        return { success: true, result: { ok: true } };
      }

      throw new Error(`unexpected rpc method: ${method}`);
    },
    upsertRepoFeatureSession: async () => {
      upsertCalls += 1;
      throw new Error('should not persist when send fails');
    },
  };

  await assert.rejects(
    createRepoFeatureSession({
      repoFullName: 'telegraphic-dev/jean-ci',
      title: 'New feature session',
      branchName: 'feat/example',
    }, deps),
    /send failed/
  );

  assert.deepEqual(
    rpcCalls.map(call => call.method),
    ['sessions.create', 'sessions.send', 'sessions.delete']
  );
  assert.equal((rpcCalls[1]?.payload as { key?: string })?.key, 'created-key');
  assert.equal((rpcCalls[2]?.payload as { key?: string })?.key, 'created-key');
  assert.equal(upsertCalls, 0);
});

test('createRepoFeatureSession cleans up gateway session when persistence fails', async () => {
  const rpcCalls: Array<{ method: string; payload: unknown }> = [];
  let upsertCalls = 0;
  const deps: RepoFeatureSessionDeps = {
    callGatewayRpc: async (method: string, payload?: unknown) => {
      rpcCalls.push({ method, payload });

      if (method === 'sessions.create') {
        return { success: true, result: { key: 'created-key', url: 'https://example.test/session/1' } };
      }
      if (method === 'sessions.send') {
        return { success: true, result: { ok: true } };
      }
      if (method === 'sessions.delete') {
        return { success: true, result: { ok: true } };
      }

      throw new Error(`unexpected rpc method: ${method}`);
    },
    upsertRepoFeatureSession: async (record) => {
      upsertCalls += 1;
      assert.equal(record.session_key, 'created-key');
      throw new Error('db failed');
    },
  };

  await assert.rejects(
    createRepoFeatureSession({
      repoFullName: 'telegraphic-dev/jean-ci',
      title: 'New feature session',
      branchName: 'feat/example',
    }, deps),
    /db failed/
  );

  assert.deepEqual(
    rpcCalls.map(call => call.method),
    ['sessions.create', 'sessions.send', 'sessions.delete']
  );
  assert.equal((rpcCalls[1]?.payload as { key?: string })?.key, 'created-key');
  assert.equal((rpcCalls[2]?.payload as { key?: string })?.key, 'created-key');
  assert.equal(upsertCalls, 1);
});

test('createRepoFeatureSession returns and persists the canonical key from sessions.create', async () => {
  const rpcCalls: Array<{ method: string; payload: unknown }> = [];
  let persistedSessionKey: string | null = null;
  const deps: RepoFeatureSessionDeps = {
    callGatewayRpc: async (method: string, payload?: unknown) => {
      rpcCalls.push({ method, payload });

      if (method === 'sessions.create') {
        return { success: true, result: { key: 'created-key', url: 'https://example.test/session/1' } };
      }
      if (method === 'sessions.send') {
        return { success: true, result: { ok: true } };
      }

      throw new Error(`unexpected rpc method: ${method}`);
    },
    upsertRepoFeatureSession: async (record) => {
      persistedSessionKey = record.session_key;
    },
  };

  const result = await createRepoFeatureSession({
    repoFullName: 'telegraphic-dev/jean-ci',
    title: 'New feature session',
    branchName: 'feat/example',
  }, deps);

  assert.equal(result.key, 'created-key');
  assert.equal(persistedSessionKey, 'created-key');
  assert.equal((rpcCalls[1]?.payload as { key?: string })?.key, 'created-key');
  assert.match(String((rpcCalls[1]?.payload as { message?: string })?.message ?? ''), /Session key: created-key/);
});

test('createRepoFeatureSession requests repo-bound feature key without duplicate agent namespace segment', async () => {
  const rpcCalls: Array<{ method: string; payload: unknown }> = [];
  const deps: RepoFeatureSessionDeps = {
    callGatewayRpc: async (method: string, payload?: unknown) => {
      rpcCalls.push({ method, payload });

      if (method === 'sessions.create') {
        return { success: true, result: { key: 'created-key' } };
      }
      if (method === 'sessions.send') {
        return { success: true, result: { ok: true } };
      }

      throw new Error(`unexpected rpc method: ${method}`);
    },
    upsertRepoFeatureSession: async () => {},
  };

  await createRepoFeatureSession({
    repoFullName: 'telegraphic-dev/jean-ci',
    title: 'Session key format test',
  }, deps);

  const createPayload = (rpcCalls[0]?.payload as { key?: string }) || {};
  assert.match(createPayload.key || '', /^jean-ci:telegraphic-dev-jean-ci:feature:[a-f0-9-]{36}$/);
});
