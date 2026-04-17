import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepoFeatureSession } from '../lib/repo-feature-sessions.ts';

test('createRepoFeatureSession validates required input before RPC', async () => {
  const original = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  process.env.OPENCLAW_GATEWAY_PUBLIC_URL = 'https://carita.tailf99986.ts.net';

  try {
    await assert.rejects(() => createRepoFeatureSession({ repoFullName: '', initialIdea: 'x' }), /owner\/repo/);
    await assert.rejects(() => createRepoFeatureSession({ repoFullName: 'telegraphic-dev/jean-ci', initialIdea: '' }), /initialIdea is required/);
  } finally {
    if (original == null) delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
    else process.env.OPENCLAW_GATEWAY_PUBLIC_URL = original;
  }
});
