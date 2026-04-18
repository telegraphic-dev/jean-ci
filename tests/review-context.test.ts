import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalRepoPath, buildReviewContext, extractChangedFilePaths } from '../lib/review-context.ts';

test('extractChangedFilePaths keeps exact repo-relative paths from git diff headers', () => {
  const diff = [
    'diff --git a/openclaw-mentor/lib/publications.ts b/openclaw-mentor/lib/publications.ts',
    '--- a/openclaw-mentor/lib/publications.ts',
    '+++ b/openclaw-mentor/lib/publications.ts',
    '@@ -1,1 +1,1 @@',
    '+const x = 1;',
    'diff --git a/docs/old.md b/docs/new.md',
    'similarity index 98%',
    'rename from docs/old.md',
    'rename to docs/new.md',
  ].join('\n');

  assert.deepEqual(extractChangedFilePaths(diff), [
    'openclaw-mentor/lib/publications.ts',
    'docs/new.md',
  ]);
});

test('buildReviewContext includes literal changed paths and nested repo guidance', () => {
  const diff = [
    'diff --git a/openclaw-mentor/lib/publications.ts b/openclaw-mentor/lib/publications.ts',
    '--- a/openclaw-mentor/lib/publications.ts',
    '+++ b/openclaw-mentor/lib/publications.ts',
    '@@ -1,1 +1,1 @@',
    '+const x = 1;',
  ].join('\n');

  const context = buildReviewContext({
    title: 'Fix publications flow',
    body: 'Review nested repo paths carefully.',
    diff,
    diffLimit: 200000,
    owner: 'telegraphic-dev',
    repo: 'openclaw-mentor',
  });

  assert.match(context, /## Repository Context/);
  assert.match(context, /Canonical local checkout path: \/home\/openclaw\/.openclaw\/workspace\/development\/projects\/telegraphic-dev\/openclaw-mentor/);
  assert.match(context, /Do not strip, rewrite, or guess away leading directories/i);
  assert.match(context, /Some changed files already begin with the repo-name directory prefix `openclaw-mentor\/\.\.\.`/);
  assert.match(context, /`\/home\/openclaw\/.openclaw\/workspace\/development\/projects\/telegraphic-dev\/openclaw-mentor\/openclaw-mentor\/lib\/publications\.ts`/);
  assert.match(context, /## Changed Files/);
  assert.match(context, /- openclaw-mentor\/lib\/publications\.ts/);
});

test('buildCanonicalRepoPath returns the workspace canonical repo location', () => {
  assert.equal(
    buildCanonicalRepoPath('telegraphic-dev', 'jean-ci'),
    '/home/openclaw/.openclaw/workspace/development/projects/telegraphic-dev/jean-ci',
  );
});
