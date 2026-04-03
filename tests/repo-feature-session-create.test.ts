import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepoFeatureSession } from '../lib/repo-feature-sessions.ts';

test('createRepoFeatureSession validates required input before RPC', async () => {
  await assert.rejects(() => createRepoFeatureSession({ repoFullName: '', title: 'x' }), /owner\/repo/);
  await assert.rejects(() => createRepoFeatureSession({ repoFullName: 'telegraphic-dev/jean-ci', title: '' }), /title is required/);
});
