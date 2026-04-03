import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoSessionSeedPrompt } from '../lib/repo-feature-session-prompt.ts';

test('buildRepoSessionSeedPrompt binds the session to a repository and PR backlink rules', () => {
  const prompt = buildRepoSessionSeedPrompt('telegraphic-dev/jean-ci');

  assert.match(prompt, /permanently bound to repository telegraphic-dev\/jean-ci/i);
  assert.match(prompt, /oc-session:SESSION_KEY/);
  assert.match(prompt, /visible Jean-CI session backlink/i);
  assert.match(prompt, /PR review and CI feedback will be injected back/i);
});
