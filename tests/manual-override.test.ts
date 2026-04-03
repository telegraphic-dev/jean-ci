import test from 'node:test';
import assert from 'node:assert/strict';

function canCreateOverrideApproval(checkRun: {
  head_sha?: string | null;
  pr_number: number;
}, prInfo: {
  state?: string;
  draft?: boolean;
  head?: { sha?: string | null };
} | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!prInfo) {
    return { ok: false, reason: `PR #${checkRun.pr_number} was not found` };
  }

  if (prInfo.state !== 'open') {
    return { ok: false, reason: `PR #${checkRun.pr_number} is not open` };
  }

  if (prInfo.draft) {
    return { ok: false, reason: `PR #${checkRun.pr_number} is still a draft` };
  }

  const reviewHeadSha = (checkRun.head_sha || '').trim();
  const currentPrHeadSha = (prInfo.head?.sha || '').trim();
  if (reviewHeadSha && currentPrHeadSha && reviewHeadSha !== currentPrHeadSha) {
    return {
      ok: false,
      reason: `PR #${checkRun.pr_number} head changed from ${reviewHeadSha} to ${currentPrHeadSha}`,
    };
  }

  return { ok: true };
}

test('canCreateOverrideApproval accepts open non-draft PR with matching head sha', () => {
  const result = canCreateOverrideApproval(
    { pr_number: 42, head_sha: 'abc123' },
    { state: 'open', draft: false, head: { sha: 'abc123' } },
  );

  assert.deepEqual(result, { ok: true });
});

test('canCreateOverrideApproval rejects closed PRs', () => {
  const result = canCreateOverrideApproval(
    { pr_number: 42, head_sha: 'abc123' },
    { state: 'closed', draft: false, head: { sha: 'abc123' } },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not open/);
  }
});

test('canCreateOverrideApproval rejects draft PRs', () => {
  const result = canCreateOverrideApproval(
    { pr_number: 42, head_sha: 'abc123' },
    { state: 'open', draft: true, head: { sha: 'abc123' } },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /draft/);
  }
});

test('canCreateOverrideApproval rejects head sha mismatch', () => {
  const result = canCreateOverrideApproval(
    { pr_number: 42, head_sha: 'abc123' },
    { state: 'open', draft: false, head: { sha: 'def456' } },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /head changed/);
  }
});
