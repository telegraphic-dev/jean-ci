import test from 'node:test';
import assert from 'node:assert/strict';
import { getPRDiff, isRetryablePullRequestDiffError } from '../lib/github.ts';

test('isRetryablePullRequestDiffError recognizes GitHub temporary diff unavailability', () => {
  assert.equal(
    isRetryablePullRequestDiffError({
      status: 500,
      message: 'Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.',
    }),
    true,
  );

  assert.equal(isRetryablePullRequestDiffError({ status: 404, message: 'Not Found' }), false);
  assert.equal(isRetryablePullRequestDiffError({ status: 500, message: 'unrelated server error' }), true);
});

test('getPRDiff retries transient GitHub diff failures before returning diff', async () => {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      if (calls.length === 1) {
        const error = new Error('Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.') as Error & { status: number };
        error.status = 500;
        throw error;
      }
      return { data: 'diff --git a/a b/a\n+ok\n' };
    },
  };

  const diff = await getPRDiff(octokit, 'telegraphic-dev', 'juv', 14, {
    maxAttempts: 2,
    retryDelayMs: 0,
  });

  assert.equal(diff, 'diff --git a/a b/a\n+ok\n');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.params, {
    owner: 'telegraphic-dev',
    repo: 'juv',
    pull_number: 14,
    mediaType: { format: 'diff' },
  });
});

test('getPRDiff does not retry non-retryable GitHub errors', async () => {
  let calls = 0;
  const octokit = {
    request: async () => {
      calls += 1;
      const error = new Error('Not Found') as Error & { status: number };
      error.status = 404;
      throw error;
    },
  };

  await assert.rejects(
    () => getPRDiff(octokit, 'telegraphic-dev', 'juv', 14, { maxAttempts: 3, retryDelayMs: 0 }),
    /Not Found/,
  );
  assert.equal(calls, 1);
});
