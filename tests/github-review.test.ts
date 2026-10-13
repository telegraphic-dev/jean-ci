import test from 'node:test';
import assert from 'node:assert/strict';
import { createPRReview } from '../lib/github.ts';

test('createPRReview pins the review to the validated commit', async () => {
  let request: { route: string; params: Record<string, unknown> } | undefined;
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      request = { route, params };
      return { data: { id: 1 } };
    },
  };

  await createPRReview(octokit, 'telegraphic-dev', 'jean-ci', 157, 'REQUEST_CHANGES', 'Review body', 'abc123');

  assert.deepEqual(request, {
    route: 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
    params: {
      owner: 'telegraphic-dev',
      repo: 'jean-ci',
      pull_number: 157,
      commit_id: 'abc123',
      event: 'REQUEST_CHANGES',
      body: 'Review body',
    },
  });
});