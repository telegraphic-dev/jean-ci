import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRepoFeatureSessionChat,
  sendRepoFeatureSessionChatMessage,
  type RepoFeatureSessionChatDeps,
} from '../lib/repo-feature-session-chat.ts';

test('getRepoFeatureSessionChat returns normalized transcript messages', async () => {
  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: 'session-1',
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

  const result = await getRepoFeatureSessionChat('telegraphic-dev/jean-ci', 'session-1', deps);
  assert.equal(result.sessionKey, 'session-1');
  assert.deepEqual(result.messages, [
    { role: 'system', text: 'seed' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there' },
  ]);
});

test('sendRepoFeatureSessionChatMessage waits for run completion and updates activity timestamp', async () => {
  const calls: string[] = [];
  let upserted = false;

  const deps: RepoFeatureSessionChatDeps = {
    getRepoFeatureSessions: async () => ([{
      session_key: 'session-1',
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
      assert.equal(record.session_key, 'session-1');
      assert.ok(record.last_activity_at instanceof Date);
      return {
        id: 1,
        session_key: 'session-1',
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
    callGatewayRpc: async (method: string) => {
      calls.push(method);
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

  const result = await sendRepoFeatureSessionChatMessage('telegraphic-dev/jean-ci', 'session-1', 'please implement chat', deps);
  assert.deepEqual(calls, ['sessions.send', 'agent.wait', 'sessions.get']);
  assert.equal(result.runStatus, 'idle');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.messages.at(-1)?.text, 'done');
  assert.equal(upserted, true);
});
