import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverInterruptedChecks } from '../lib/interrupted-check-recovery.ts';

for (const mode of ['delivered', 'already-completed', 'read-404', 'patch-404', 'not-visible'] as const) {
  test(`pending terminal completion reconciliation: ${mode}`, async () => {
    const output = { status: 'completed', conclusion: 'failure', output: { title: 'Failed', summary: 'Public finding' } };
    const acknowledgements: any[] = [];
    let reads = 0, patches = 0;
    const result = await recoverInterruptedChecks({
      listInterruptedChecks: async () => [{ id: 1, github_check_id: 42, repo: 'owner/repo', pr_number: 1,
        check_name: 'Code Review', status: 'completed', conclusion: 'failure', summary: 'PRIVATE_DIAGNOSTICS',
        created_at: new Date(), github_completion: output }],
      getRepo: async () => ({ installation_id: 1 } as any),
      getInstallationOctokit: async () => ({}),
      getGitHubCheck: async () => {
        reads++;
        if (mode === 'read-404') throw Object.assign(new Error('Not Found'), { status: 404 });
        return { status: mode === 'already-completed' || (mode === 'delivered' && reads > 1) ? 'completed' : 'queued', conclusion: 'success' };
      },
      completeGitHubCheck: async (_kit, owner, repo, id, updates) => {
        patches++;
        assert.equal(owner, 'owner'); assert.equal(repo, 'repo'); assert.equal(id, 42);
        assert.deepEqual(updates, output);
        if (mode === 'patch-404') throw Object.assign(new Error('Not Found'), { status: 404 });
      },
      markCheckCompleted: async (...args) => { acknowledgements.push(args); },
      detailsUrl: String,
    });
    const delivered = mode === 'delivered' || mode === 'already-completed';
    assert.deepEqual(result, { recovered: delivered ? 1 : 0, skipped: 0, failed: delivered ? 0 : 1 });
    assert.deepEqual(acknowledgements, delivered ? [[1, { github_completion: null }]] : []);
    assert.equal(patches, mode === 'read-404' || mode === 'already-completed' ? 0 : 1);
  });
}

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
    getGitHubCheck: async () => ({ status: 'in_progress' }),
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
    getGitHubCheck: async () => { called = true; return {}; },
    completeGitHubCheck: async () => { called = true; },
    markCheckCompleted: async () => { called = true; },
    detailsUrl: (id) => String(id),
  });

  assert.deepEqual(result, { recovered: 0, skipped: 1, failed: 0 });
  assert.equal(called, false);
});

test('synchronizes a check that GitHub completed before the database write', async () => {
  const dbUpdates: any[] = [];
  let githubUpdated = false;
  const result = await recoverInterruptedChecks({
    listInterruptedChecks: async () => [{
      id: 4431, github_check_id: 115232571959, repo: 'telegraphic-dev/a2a-exposed-site',
      pr_number: 52, check_name: 'Code Review', status: 'queued', created_at: new Date(),
    }],
    getRepo: async () => ({ installation_id: 123 } as any),
    getInstallationOctokit: async () => ({}),
    getGitHubCheck: async () => ({
      status: 'completed', conclusion: 'failure', completed_at: '2026-10-13T10:00:00Z',
      output: { title: 'Review failed', summary: 'The review found a problem.' },
    }),
    completeGitHubCheck: async () => { githubUpdated = true; },
    markCheckCompleted: async (_id, data) => { dbUpdates.push(data); },
    detailsUrl: (id) => String(id),
  });

  assert.deepEqual(result, { recovered: 1, skipped: 0, failed: 0 });
  assert.equal(githubUpdated, false);
  assert.equal(dbUpdates[0]?.conclusion, 'failure');
  assert.equal(dbUpdates[0]?.title, 'Review failed');
});