import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepoAdminPath } from '../lib/admin/repo-links.ts';

test('getRepoAdminPath builds repo admin path for standard owner/repo names', () => {
  assert.equal(getRepoAdminPath('telegraphic-dev/jean-ci'), '/admin/repos/telegraphic-dev/jean-ci/sessions');
});

test('getRepoAdminPath preserves additional slashes inside repo name', () => {
  assert.equal(
    getRepoAdminPath('example/nested/repo'),
    '/admin/repos/example/nested%2Frepo/sessions'
  );
});

test('getRepoAdminPath falls back for malformed repo names', () => {
  assert.equal(getRepoAdminPath('invalid'), '/admin/repos');
  assert.equal(getRepoAdminPath('/repo'), '/admin/repos');
  assert.equal(getRepoAdminPath('owner/'), '/admin/repos');
});
