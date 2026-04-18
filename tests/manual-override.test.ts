import test from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE_DATE = new Date('2026-04-05T06:30:00Z');

async function loadTestHelpers() {
  const mod = await import('../lib/manual-override.ts');
  return mod.__test__;
}

test('performManualOverride updates GitHub check and records DB override for non-global checks', async () => {
  const calls: string[] = [];
  const { performManualOverrideWithDeps } = await loadTestHelpers();

  const result = await performManualOverrideWithDeps(42, 'ship it', 'vlad', {
    getCheckRun: async () => ({
      id: 42,
      github_check_id: 1234,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 99,
      check_name: 'security',
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      created_at: FIXTURE_DATE,
    } as any),
    getRepo: async () => ({ installation_id: 777 } as any),
    overrideCheckRunToPass: async () => ({
      id: 42,
      github_check_id: 1234,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 99,
      check_name: 'security',
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      manually_overridden: true,
      override_reason: 'ship it',
      overridden_by: 'vlad',
      created_at: FIXTURE_DATE,
    } as any),
    rollbackManualOverride: async () => {
      throw new Error('should not rollback on happy path');
    },
    getInstallationOctokit: async () => ({ token: 'octokit' } as any),
    getPRInfo: async () => {
      throw new Error('should not fetch PR info for non-global checks');
    },
    createPRReview: async () => {
      throw new Error('should not create PR review for non-global checks');
    },
    updateCheck: async (...args: any[]) => {
      calls.push(`updateCheck:${args[3]}`);
      return {} as any;
    },
    canCreateOverrideApproval: () => ({ ok: true } as const),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.githubCheckUpdated, true);
  assert.equal(result.githubReviewSubmitted, false);
  assert.deepEqual(calls, ['updateCheck:1234']);
});

test('performManualOverride submits GitHub approval review for global review checks', async () => {
  const calls: string[] = [];
  const { performManualOverrideWithDeps } = await loadTestHelpers();

  const result = await performManualOverrideWithDeps(43, 'approved manually', 'vlad', {
    getCheckRun: async () => ({
      id: 43,
      github_check_id: 5678,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 100,
      check_name: 'Code Review',
      head_sha: 'def456',
      status: 'completed',
      conclusion: 'failure',
      created_at: FIXTURE_DATE,
    } as any),
    getRepo: async () => ({ installation_id: 777 } as any),
    overrideCheckRunToPass: async () => ({
      id: 43,
      github_check_id: 5678,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 100,
      check_name: 'Code Review',
      head_sha: 'def456',
      status: 'completed',
      conclusion: 'failure',
      manually_overridden: true,
      override_reason: 'approved manually',
      overridden_by: 'vlad',
      created_at: FIXTURE_DATE,
    } as any),
    rollbackManualOverride: async () => {
      throw new Error('should not rollback on happy path');
    },
    getInstallationOctokit: async () => ({ token: 'octokit' } as any),
    getPRInfo: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'def456' },
    } as any),
    createPRReview: async () => {
      calls.push('createPRReview');
      return {} as any;
    },
    updateCheck: async (...args: any[]) => {
      calls.push(`updateCheck:${args[3]}`);
      return {} as any;
    },
    canCreateOverrideApproval: () => ({ ok: true } as const),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.githubCheckUpdated, true);
  assert.equal(result.githubReviewSubmitted, true);
  assert.deepEqual(calls, ['updateCheck:5678', 'createPRReview']);
});

test('performManualOverride rejects global review override when approval eligibility fails', async () => {
  const { performManualOverrideWithDeps } = await loadTestHelpers();

  const result = await performManualOverrideWithDeps(44, 'approved manually', 'vlad', {
    getCheckRun: async () => ({
      id: 44,
      github_check_id: 5678,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 101,
      check_name: 'Code Review',
      head_sha: 'oldsha',
      status: 'completed',
      conclusion: 'failure',
      created_at: FIXTURE_DATE,
    } as any),
    getRepo: async () => ({ installation_id: 777 } as any),
    overrideCheckRunToPass: async () => {
      throw new Error('should not record DB override when GitHub override is invalid');
    },
    rollbackManualOverride: async () => {
      throw new Error('should not rollback when DB write never happened');
    },
    getInstallationOctokit: async () => ({ token: 'octokit' } as any),
    getPRInfo: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'newsha' },
    } as any),
    createPRReview: async () => {
      throw new Error('should not create PR review when approval eligibility fails');
    },
    updateCheck: async () => {
      throw new Error('should not update check when approval eligibility fails');
    },
    canCreateOverrideApproval: () => ({ ok: false, reason: 'PR #101 head changed from oldsha to newsha' } as const),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.error, /head changed/i);
});

test('performManualOverride does not mutate GitHub if DB override cannot be recorded', async () => {
  const calls: string[] = [];
  const { performManualOverrideWithDeps } = await loadTestHelpers();

  const result = await performManualOverrideWithDeps(45, 'approved manually', 'vlad', {
    getCheckRun: async () => ({
      id: 45,
      github_check_id: 91011,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 102,
      check_name: 'Code Review',
      head_sha: 'sha102',
      status: 'completed',
      conclusion: 'failure',
      created_at: FIXTURE_DATE,
    } as any),
    getRepo: async () => ({ installation_id: 777 } as any),
    overrideCheckRunToPass: async () => null,
    rollbackManualOverride: async () => {
      throw new Error('should not rollback when DB write was not recorded');
    },
    getInstallationOctokit: async () => ({ token: 'octokit' } as any),
    getPRInfo: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'sha102' },
    } as any),
    createPRReview: async () => {
      calls.push('createPRReview');
      return {} as any;
    },
    updateCheck: async () => {
      calls.push('updateCheck');
      return {} as any;
    },
    canCreateOverrideApproval: () => ({ ok: true } as const),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.error, /before override could be recorded/i);
  assert.deepEqual(calls, []);
});

test('performManualOverride rolls back DB override when GitHub sync fails', async () => {
  const calls: string[] = [];
  const { performManualOverrideWithDeps } = await loadTestHelpers();

  const result = await performManualOverrideWithDeps(46, 'approved manually', 'vlad', {
    getCheckRun: async () => ({
      id: 46,
      github_check_id: 1112,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 103,
      check_name: 'Code Review',
      head_sha: 'sha103',
      status: 'completed',
      conclusion: 'failure',
      created_at: FIXTURE_DATE,
    } as any),
    getRepo: async () => ({ installation_id: 777 } as any),
    overrideCheckRunToPass: async () => ({
      id: 46,
      github_check_id: 1112,
      repo: 'telegraphic-dev/jean-ci',
      pr_number: 103,
      check_name: 'Code Review',
      head_sha: 'sha103',
      status: 'completed',
      conclusion: 'failure',
      manually_overridden: true,
      override_reason: 'approved manually',
      overridden_by: 'vlad',
      created_at: FIXTURE_DATE,
    } as any),
    rollbackManualOverride: async (_id: number, previousSummary: string | null | undefined) => {
      calls.push(`rollbackManualOverride:${previousSummary ?? '<null>'}`);
      return {} as any;
    },
    getInstallationOctokit: async () => ({ token: 'octokit' } as any),
    getPRInfo: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'sha103' },
    } as any),
    createPRReview: async () => {
      calls.push('createPRReview');
      throw new Error('GitHub review API exploded');
    },
    updateCheck: async (...args: any[]) => {
      const conclusion = args[4]?.conclusion;
      calls.push(`updateCheck:${conclusion || 'unknown'}`);
      return {} as any;
    },
    canCreateOverrideApproval: () => ({ ok: true } as const),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 502);
  assert.match(result.error, /GitHub override failed/i);
  assert.deepEqual(calls, [
    'updateCheck:success',
    'createPRReview',
    'updateCheck:failure',
    'rollbackManualOverride:<null>',
  ]);
});
