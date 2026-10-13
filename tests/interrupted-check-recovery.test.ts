import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverInterruptedChecks } from '../lib/interrupted-check-recovery.ts';

test('completes an interrupted GitHub check as neutral after restart', async () => {
  const githubUpdates: any[] = [];
  const dbUpdates: any[] = [];
  const result = await recoverInterruptedChecks({
    listInterruptedChecks: async () => [{
      id: 4431,
      github_check_id: 115232571959,
      repo: 'telegraphic-dev/a2a-exposed-site',
      pr_number: 52,
      check_name: 'Code Review',
      status: 'in_progress',
      created_at: new Date('2026-10-13T09:44:11Z'),
    }],
    getRepo: async () => ({ installation_id: 123 } as any),
    getInstallationOctokit: async () => ({ installation: 'octokit' }),
    completeGitHubCheck: async (_octokit, owner, repo, id, updates) => {
      githubUpdates.push({ owner, repo, id, updates });
    },
    markCheckCompleted: async (id, update) => { dbUpdates.push({ id, update }); },
    detailsUrl: (id) => `https://jean-ci.example/checks/${id}`,
  }, new Date('2026-10-13T10:00:00Z'));

  assert.deepEqual(result, { recovered: 1, skipped: 0, failed: 0 });
  assert.equal(githubUpdates[0]?.id, 115232571959);
  assert.equal(githubUpdates[0]?.updates.conclusion, 'neutral');
  assert.match(githubUpdates[0]?.updates.output.summary, /re-request the check/i);
  assert.equal(dbUpdates[0]?.id, 4431);
  assert.equal(dbUpdates[0]?.update.status, 'completed');
  assert.equal(dbUpdates[0]?.update.conclusion, 'neutral');
});

test('does not update GitHub when an interrupted row has no repository installation', async () => {
  let called = false;
  const result = await recoverInterruptedChecks({
    listInterruptedChecks: async () => [{
      id: 1,
      github_check_id: 2,
      repo: 'telegraphic-dev/a2a-exposed-site',
      pr_number: 52,
      check_name: 'Code Review',
      status: 'queued',
      created_at: new Date(),
    }],
    getRepo: async () => null,
    getInstallationOctokit: async () => { called = true; return {}; },
    completeGitHubCheck: async () => { called = true; },
    markCheckCompleted: async () => { called = true; },
    detailsUrl: (id) => String(id),
  });

  assert.deepEqual(result, { recovered: 0, skipped: 1, failed: 0 });
  assert.equal(called, false);
});