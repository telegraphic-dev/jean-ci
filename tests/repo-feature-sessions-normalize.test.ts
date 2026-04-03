import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewaySession } from '../lib/repo-feature-sessions.ts';

test('normalizeGatewaySession accepts explicit repoFullName payload', () => {
  const result = normalizeGatewaySession({
    key: 'sess_1',
    label: 'Feature work',
    repoFullName: 'telegraphic-dev/jean-ci',
    branchName: 'feat/x',
    status: 'active',
    lastActivityAt: '2026-04-03T14:00:00Z',
    sessionUrl: 'https://example.com/session',
    prNumber: 119,
    prUrl: 'https://github.com/telegraphic-dev/jean-ci/pull/119',
  });

  assert.deepEqual(result, {
    key: 'sess_1',
    label: 'Feature work',
    repoFullName: 'telegraphic-dev/jean-ci',
    branchName: 'feat/x',
    status: 'active',
    lastActivityAt: '2026-04-03T14:00:00Z',
    sessionUrl: 'https://example.com/session',
    prNumber: 119,
    prUrl: 'https://github.com/telegraphic-dev/jean-ci/pull/119',
  });
});

test('normalizeGatewaySession accepts metadata fallback fields', () => {
  const result = normalizeGatewaySession({
    sessionKey: 'sess_2',
    metadata: {
      repo: 'telegraphic-dev/jean-ci',
      branch: 'feat/y',
      status: 'done',
      deepLink: 'https://example.com/session/2',
      prNumber: '120',
      prUrl: 'https://github.com/telegraphic-dev/jean-ci/pull/120',
    },
  });

  assert.deepEqual(result, {
    key: 'sess_2',
    label: 'sess_2',
    repoFullName: 'telegraphic-dev/jean-ci',
    branchName: 'feat/y',
    status: 'done',
    lastActivityAt: null,
    sessionUrl: 'https://example.com/session/2',
    prNumber: 120,
    prUrl: 'https://github.com/telegraphic-dev/jean-ci/pull/120',
  });
});

test('normalizeGatewaySession rejects items without a valid repo contract', () => {
  assert.equal(normalizeGatewaySession({ key: 'sess_3' }), null);
  assert.equal(normalizeGatewaySession({ key: 'sess_4', repoFullName: 'jean-ci' }), null);
  assert.equal(normalizeGatewaySession('bad-payload'), null);
});
