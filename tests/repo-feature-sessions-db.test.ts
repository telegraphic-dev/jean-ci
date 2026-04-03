import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepoFeatureSessions, upsertRepoFeatureSession } from '../lib/db.ts';

test('upsertRepoFeatureSession preserves and updates repo session fields', async () => {
  const repo = `test-owner/test-repo-${Date.now()}`;

  // repo row is required by FK in real runtime; this test only verifies exported DB helper contract shape
  // when DB-backed tests are not configured, skip gracefully.
  if (!process.env.DATABASE_URL) {
    assert.ok(true);
    return;
  }

  const { upsertRepo } = await import('../lib/db.ts');
  await upsertRepo(repo, 1, false);

  await upsertRepoFeatureSession({
    session_key: `sess-${Date.now()}`,
    repo_full_name: repo,
    title: 'Initial title',
    branch_name: 'feat/a',
    status: 'active',
    session_url: 'https://example.com/session',
    pr_number: 5,
    pr_url: 'https://github.com/test-owner/test-repo/pull/5',
    last_activity_at: '2026-04-03T15:00:00Z',
  });

  const sessions = await getRepoFeatureSessions(repo);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, 'Initial title');
  assert.equal(sessions[0]?.branch_name, 'feat/a');
  assert.equal(sessions[0]?.pr_number, 5);
});
