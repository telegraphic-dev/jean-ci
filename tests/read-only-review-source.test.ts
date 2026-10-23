import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, buildReviewUserMessage, reviewRequestLength } from '../lib/review-request.ts';

test('source inspection supports immutable objects without requiring a checkout', () => {
  assert.match(SYSTEM_PROMPT, /pinned checkout is not required for source-only inspection/);
  assert.match(SYSTEM_PROMPT, /git show <reviewed-sha>:<path>/);
  assert.match(SYSTEM_PROMPT, /git ls-tree <reviewed-sha>/);
  assert.match(SYSTEM_PROMPT, /Do not fetch into or modify that repository/);
  assert.match(SYSTEM_PROMPT, /GET repository contents at the exact reviewed SHA/);
  assert.match(SYSTEM_PROMPT, /files unmodified relative to that commit/);
});

test('source workflow retains approval and evidence boundaries', () => {
  assert.match(SYSTEM_PROMPT, /Do not clone, fetch, checkout, create temporary workspaces/);
  assert.match(SYSTEM_PROMPT, /Do not execute repository code, install dependencies, or run hooks/);
  assert.match(SYSTEM_PROMPT, /untrusted review input/);
  assert.match(SYSTEM_PROMPT, /omitted\/truncated content/);
  assert.match(SYSTEM_PROMPT, /required unavailable evidence as INCOMPLETE/);
  assert.match(SYSTEM_PROMPT, /normal approval flow/);
  assert.match(SYSTEM_PROMPT, /switch tools to evade a denial/);
  assert.match(SYSTEM_PROMPT, /Source-only inspection should not create a workspace/);
});

test('transport accounting includes the complete source guidance', () => {
  const prompt = 'Review changed authorization code';
  const context = 'Reviewed commit: 55885a20d2b32744436be52731cbe1b49943d56f';
  assert.equal(reviewRequestLength(prompt, context), SYSTEM_PROMPT.length + 2 + buildReviewUserMessage(prompt, context).length);
});
