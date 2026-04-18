import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoSessionSeedPrompt } from '../lib/repo-feature-session-prompt.ts';
import { createRepoFeatureSession, isRepoFeatureSessionKeyForRepo, type RepoFeatureSessionDeps } from '../lib/repo-feature-sessions.ts';

const GATEWAY_PUBLIC_URL = 'https://carita.tailf99986.ts.net';

async function withGatewayPublicUrl(fn: () => Promise<void> | void) {
  const original = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  process.env.OPENCLAW_GATEWAY_PUBLIC_URL = GATEWAY_PUBLIC_URL;
  try {
    await fn();
  } finally {
    if (original == null) delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
    else process.env.OPENCLAW_GATEWAY_PUBLIC_URL = original;
  }
}

async function withOpenClawAgentId(agentId: string, fn: () => Promise<void> | void) {
  const original = process.env.OPENCLAW_AGENT_ID;
  process.env.OPENCLAW_AGENT_ID = agentId;
  try {
    await fn();
  } finally {
    if (original == null) delete process.env.OPENCLAW_AGENT_ID;
    else process.env.OPENCLAW_AGENT_ID = original;
  }
}

test('buildRepoSessionSeedPrompt binds the session to a repository and concrete PR backlink rules', () => {
  const prompt = buildRepoSessionSeedPrompt({
    repoFullName: 'telegraphic-dev/jean-ci',
    sessionKey: 'agent:main:discord:channel:1490241981685698620',
    sessionUrl: 'https://carita.tailf99986.ts.net/chat?session=agent%3Amain%3Adiscord%3Achannel%3A1490241981685698620',
    initialIdea: 'Rework feature sessions so jean-ci creates the chat and the real conversation continues in gateway.',
  });

  assert.match(prompt, /permanently bound to repository telegraphic-dev\/jean-ci/i);
  assert.match(prompt, /oc-session:agent:main:discord:channel:1490241981685698620/);
  assert.ok(prompt.includes('https://carita.tailf99986.ts.net/chat?session=agent%3Amain%3Adiscord%3Achannel%3A1490241981685698620'));
  assert.match(prompt, /Initial feature idea:/);
  assert.match(prompt, /real conversation continues in gateway/i);
});

test('createRepoFeatureSession requires a public gateway base url', async () => {
  const original = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;

  let rpcCalled = false;
  const deps: RepoFeatureSessionDeps = {
    callGatewayRpc: async () => {
      rpcCalled = true;
      return { success: true, result: {} };
    },
    upsertRepoFeatureSession: async () => {
      throw new Error('should not persist without public gateway url');
    },
  };

  try {
    await assert.rejects(
      createRepoFeatureSession({
        repoFullName: 'telegraphic-dev/jean-ci',
        initialIdea: 'Create a real gateway session',
      }, deps),
      /OPENCLAW_GATEWAY_PUBLIC_URL is required/
    );
    assert.equal(rpcCalled, false);
  } finally {
    if (original == null) delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
    else process.env.OPENCLAW_GATEWAY_PUBLIC_URL = original;
  }
});

test('createRepoFeatureSession cleans up gateway session when seeding fails', async () => {
  await withGatewayPublicUrl(async () => {
    const rpcCalls: Array<{ method: string; payload: unknown }> = [];
    let upsertCalls = 0;
    const deps: RepoFeatureSessionDeps = {
      callGatewayRpc: async (method: string, payload?: unknown) => {
        rpcCalls.push({ method, payload });

        if (method === 'sessions.create') {
          return { success: true, result: { key: 'created-key' } };
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
        initialIdea: 'Build a gateway-backed feature-session flow',
      }, deps),
      /send failed/
    );

    assert.deepEqual(
      rpcCalls.map(call => call.method),
      ['sessions.create', 'sessions.send', 'sessions.delete']
    );
    assert.equal((rpcCalls[1]?.payload as { key?: string })?.key, 'created-key');
    assert.equal((rpcCalls[2]?.payload as { key?: string })?.key, 'created-key');
    assert.match(String((rpcCalls[1]?.payload as { message?: string })?.message ?? ''), /oc-session:created-key/);
    assert.match(String((rpcCalls[1]?.payload as { message?: string })?.message ?? ''), /https:\/\/carita\.tailf99986\.ts\.net\/chat\?session=created-key/);
    assert.equal(upsertCalls, 0);
  });
});

test('createRepoFeatureSession cleans up gateway session when persistence fails', async () => {
  await withGatewayPublicUrl(async () => {
    const rpcCalls: Array<{ method: string; payload: unknown }> = [];
    let upsertCalls = 0;
    const deps: RepoFeatureSessionDeps = {
      callGatewayRpc: async (method: string, payload?: unknown) => {
        rpcCalls.push({ method, payload });

        if (method === 'sessions.create') {
          return { success: true, result: { key: 'created-key' } };
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
        assert.equal(record.session_url, 'https://carita.tailf99986.ts.net/chat?session=created-key');
        throw new Error('db failed');
      },
    };

    await assert.rejects(
      createRepoFeatureSession({
        repoFullName: 'telegraphic-dev/jean-ci',
        initialIdea: 'Persist a repo-bound gateway feature session',
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
});

test('createRepoFeatureSession returns and persists the canonical key from sessions.create', async () => {
  await withGatewayPublicUrl(async () => {
    const rpcCalls: Array<{ method: string; payload: unknown }> = [];
    let persistedSessionKey: string | null = null;
    let persistedSessionUrl: string | null = null;
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
      upsertRepoFeatureSession: async (record) => {
        persistedSessionKey = record.session_key;
        persistedSessionUrl = record.session_url || null;
      },
    };

    const result = await createRepoFeatureSession({
      repoFullName: 'telegraphic-dev/jean-ci',
      initialIdea: 'Move follow-up feature work into the gateway chat.',
    }, deps);

    assert.equal(result.key, 'created-key');
    assert.equal(result.sessionUrl, 'https://carita.tailf99986.ts.net/chat?session=created-key');
    assert.equal(persistedSessionKey, 'created-key');
    assert.equal(persistedSessionUrl, 'https://carita.tailf99986.ts.net/chat?session=created-key');
    assert.equal((rpcCalls[1]?.payload as { key?: string })?.key, 'created-key');
    assert.match(String((rpcCalls[1]?.payload as { message?: string })?.message ?? ''), /Session key: created-key/);
  });
});

test('createRepoFeatureSession requests repo-bound feature key without duplicate agent namespace segment', async () => {
  await withGatewayPublicUrl(async () => {
    await withOpenClawAgentId('qa', async () => {
      const rpcCalls: Array<{ method: string; payload: unknown }> = [];
      const deps: RepoFeatureSessionDeps = {
        callGatewayRpc: async (method: string, payload?: unknown) => {
          rpcCalls.push({ method, payload });

          if (method === 'sessions.create') {
            return { success: true, result: { key: 'qa:jean-ci:telegraphic-dev-jean-ci:feature:created-key' } };
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
        initialIdea: 'Session key format test',
      }, deps);

      const createPayload = (rpcCalls[0]?.payload as { key?: string; agentId?: string }) || {};
      assert.match(createPayload.key || '', /^jean-ci:telegraphic-dev-jean-ci:feature:[a-f0-9-]{36}$/);
      assert.equal(createPayload.agentId, 'qa');
    });
  });
});

test('isRepoFeatureSessionKeyForRepo accepts canonical, legacy, and gateway-prefixed key formats', async () => {
  const repo = 'telegraphic-dev/jean-ci';

  await withOpenClawAgentId('qa', async () => {
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'main:jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'qa:jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'agent:main:jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'agent:main:main:jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'agent:qa:jean-ci:telegraphic-dev-jean-ci:feature:abc'), true);
    assert.equal(isRepoFeatureSessionKeyForRepo(repo, 'jean-ci:telegraphic-dev-jean:feature:abc'), false);
  });
});
