import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeatureSessionIdempotencyKey,
  getRepoFeatureSessionChat,
  sendRepoFeatureSessionChatMessage,
  type RepoFeatureSessionChatDeps,
} from '../lib/repo-feature-session-chat.ts';

const REPO_SESSION_KEY = 'main:jean-ci:telegraphic-dev-jean-ci:feature:session-1';

test('buildFeatureSessionIdempotencyKey is stable for the same request inputs', () => {
  const a = buildFeatureSessionIdempotencyKey('session-1', 'request-1', 'hello');
  const b = buildFeatureSessionIdempotencyKey('session-1', 'request-1', 'hello');
  const c = buildFeatureSessionIdempotencyKey('session-1', 'request-2', 'hello');

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('getRepoFeatureSessionChat returns normalized transcript messages', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async () => {
      throw new Error('should not upsert on read');
    },
    callGatewayRpc: async (method: string) => {
      assert.equal(method, 'sessions.get');
      return {
        success: true,
        result: {
          messages: [
            { role: 'system', content: 'seed' },
            { role: 'user', content: [{ text: 'hello' }] },
            { role: 'assistant', message: { content: [{ text: 'hi there' }] } },
          ],
        },
      };
    },
  };

  const result = await getRepoFeatureSessionChat('telegraphic-dev/jean-ci', REPO_SESSION_KEY, deps);
  assert.equal(result.sessionKey, REPO_SESSION_KEY);
  assert.equal(result.runStatus, 'idle');
  assert.deepEqual(result.messages, [
    { role: 'system', text: 'seed' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there' },
  ]);
});

test('getRepoFeatureSessionChat marks last-user-message transcripts as running', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async () => {
      throw new Error('should not upsert on read');
    },
    callGatewayRpc: async () => ({
      success: true,
      result: {
        messages: [
          { role: 'assistant', content: 'previous reply' },
          { role: 'system', content: 'metadata' },
          { role: 'user', content: 'keep going' },
          { role: 'tool', content: 'tool output' },
        ],
      },
    }),
  };

  const result = await getRepoFeatureSessionChat('telegraphic-dev/jean-ci', REPO_SESSION_KEY, deps);
  assert.equal(result.runStatus, 'running');
});

test('sendRepoFeatureSessionChatMessage waits for run completion and updates activity timestamp', async () => {
  const calls: Array<{ method: string; payload?: any }> = [];
  let upserted = false;

  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: 'https://example.test/s/1',
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async (record) => {
      upserted = true;
      assert.equal(record.session_key, REPO_SESSION_KEY);
      assert.ok(record.last_activity_at instanceof Date);
      return {
        id: 1,
        session_key: REPO_SESSION_KEY,
        repo_full_name: 'telegraphic-dev/jean-ci',
        title: 'Feature chat',
        branch_name: 'feat/chat',
        status: 'active',
        session_url: 'https://example.test/s/1',
        pr_number: null,
        pr_url: null,
        last_activity_at: record.last_activity_at as Date,
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    callGatewayRpc: async (method: string, payload?: unknown) => {
      calls.push({ method, payload });
      if (method === 'sessions.send') {
        return { success: true, result: { runId: 'run-1', status: 'accepted' } };
      }
      if (method === 'agent.wait') {
        return { success: true, result: { status: 'ok' } };
      }
      if (method === 'sessions.get') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: 'please implement chat' },
              { role: 'assistant', content: [{ text: 'done' }] },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', REPO_SESSION_KEY, 'please implement chat', 'request-1', deps);
  assert.deepEqual(calls.map((call) => call.method), ['sessions.send', 'agent.wait', 'sessions.get']);
  assert.equal(calls[0]?.payload?.idempotencyKey, buildFeatureSessionIdempotencyKey(REPO_SESSION_KEY, 'request-1', 'please implement chat'));
  assert.equal(result.runStatus, 'idle');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.messages.at(-1)?.text, 'done');
  assert.equal(upserted, true);
});

test('sendRepoFeatureSessionChatMessage returns timeout state with transcript instead of throwing', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async (record) => ({
      id: 1,
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      last_activity_at: record.last_activity_at as Date,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    callGatewayRpc: async (method: string) => {
      if (method === 'sessions.send') {
        return { success: true, result: { runId: 'run-1', status: 'accepted' } };
      }
      if (method === 'agent.wait') {
        return { success: true, result: { status: 'timeout' } };
      }
      if (method === 'sessions.get') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: 'please implement chat' },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', REPO_SESSION_KEY, 'please implement chat', 'request-1', deps);
  assert.equal(result.runStatus, 'timeout');
  assert.equal(result.error, 'Timed out waiting for assistant reply');
  assert.equal(result.messages.at(-1)?.role, 'user');
});

test('sendRepoFeatureSessionChatMessage maps final send status when runId is missing', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async (record) => ({
      id: 1,
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      last_activity_at: record.last_activity_at as Date,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    callGatewayRpc: async (method: string) => {
      if (method === 'sessions.send') {
        return { success: true, result: { status: 'completed' } };
      }
      if (method === 'sessions.get') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: 'please implement chat' },
              { role: 'assistant', content: 'done' },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', REPO_SESSION_KEY, 'please implement chat', 'request-1', deps);
  assert.equal(result.runStatus, 'idle');
  assert.equal(result.runId, undefined);
});

test('sendRepoFeatureSessionChatMessage waits by session key when runId is missing and send status is non-final', async () => {
  const calls: string[] = [];
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async (record) => ({
      id: 1,
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      last_activity_at: record.last_activity_at as Date,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    callGatewayRpc: async (method: string, payload?: any) => {
      calls.push(method);
      if (method === 'sessions.send') {
        return { success: true, result: { status: 'accepted' } };
      }
      if (method === 'agent.wait') {
        assert.equal(payload?.runId, undefined);
        assert.equal(payload?.key, REPO_SESSION_KEY);
        return { success: true, result: { status: 'timeout' } };
      }
      if (method === 'sessions.get') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: 'please implement chat' },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', REPO_SESSION_KEY, 'please implement chat', 'request-1', deps);
  assert.deepEqual(calls, ['sessions.send', 'agent.wait', 'sessions.get']);
  assert.equal(result.runId, undefined);
  assert.equal(result.runStatus, 'timeout');
  assert.equal(result.error, 'Timed out waiting for assistant reply');
});

test('sendRepoFeatureSessionChatMessage preserves running status even if transcript ends with an older assistant reply', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async (record) => ({
      id: 1,
      session_key: REPO_SESSION_KEY,
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Feature chat',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      last_activity_at: record.last_activity_at as Date,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    callGatewayRpc: async (method: string) => {
      if (method === 'sessions.send') {
        return { success: true, result: { runId: 'run-1', status: 'accepted' } };
      }
      if (method === 'agent.wait') {
        return { success: true, result: { status: 'accepted' } };
      }
      if (method === 'sessions.get') {
        return {
          success: true,
          result: {
            messages: [
              { role: 'user', content: 'older prompt' },
              { role: 'assistant', content: 'older reply' },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', REPO_SESSION_KEY, 'please implement chat', 'request-1', deps);
  assert.equal(result.runStatus, 'running');
  assert.equal(result.error, 'Run still in progress: accepted');
});

test('repo feature session chat rejects session keys outside the repo namespace before gateway access', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: 'main:jean-ci:other-repo:feature:session-9',
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Wrong session',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async () => {
      throw new Error('should not upsert');
    },
    callGatewayRpc: async () => {
      throw new Error('should not reach gateway');
    },
  };

  await assert.rejects(
    () => getRepoFeatureSessionChat('telegraphic-dev/jean-ci', 'main:jean-ci:other-repo:feature:session-9', deps),
    /Feature session key does not belong to this repository/
  );
});

test('repo feature session chat rejects prefix-collision session keys from another repo', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: 'main:jean-ci:telegraphic-dev-jean:feature:session-9',
      repo_full_name: 'telegraphic-dev/jean-ci',
      title: 'Collision session',
      branch_name: 'feat/chat',
      status: 'active',
      session_url: null,
      pr_number: null,
      pr_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]),
    upsertRepoFeatureSession: async () => {
      throw new Error('should not upsert');
    },
    callGatewayRpc: async () => {
      throw new Error('should not reach gateway');
    },
  };

  await assert.rejects(
    () => getRepoFeatureSessionChat('telegraphic-dev/jean', 'main:jean-ci:telegraphic-dev-jean-ci:feature:session-9', deps),
    /Feature session key does not belong to this repository/
  );
});
