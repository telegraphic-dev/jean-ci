import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalRepoPath, buildReviewContext, buildReviewContexts, extractChangedFilePaths, splitReviewDiffBySubsystem } from '../lib/review-context.ts';

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

test('large diffs are grouped into bounded subsystem review contexts', () => {
  const diff = [
    'diff --git a/app/page.tsx b/app/page.tsx\nui-one',
    'diff --git a/app/form.tsx b/app/form.tsx\nui-two',
    'diff --git a/lib/service.ts b/lib/service.ts\nbackend-one',
    'diff --git a/docs/readme.md b/docs/readme.md\ndocs-one',
  ].join('\n');
  const chunks = splitReviewDiffBySubsystem(diff, 160);
  assert.deepEqual(chunks.map((chunk) => chunk.subsystem), ['frontend', 'backend', 'documentation']);
  assert.equal(chunks[0]?.diff.includes('app/page.tsx'), true);
  assert.equal(chunks[0]?.diff.includes('app/form.tsx'), true);

  const contexts = buildReviewContexts({ title: 'Large change', diff, diffLimit: 160 });
  assert.equal(contexts.length, 3);
  assert.match(contexts[0]?.context || '', /subsystem segment frontend \(1\/3\)/);
  assert.match(contexts[1]?.context || '', /subsystem segment backend \(2\/3\)/);
});

test('oversized file patches are split without dropping later hunks', () => {
  const diff = [
    'diff --git a/lib/large.ts b/lib/large.ts',
    '--- a/lib/large.ts',
    '+++ b/lib/large.ts',
    '@@ -1 +1 @@',
    `+${'a'.repeat(120)}`,
    '@@ -2 +2 @@',
    `+${'b'.repeat(120)}`,
  ].join('\n');
  const chunks = splitReviewDiffBySubsystem(diff, 100);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.subsystem === 'backend'), true);
  assert.equal(chunks.map((chunk) => chunk.diff).join('').split('b').length - 1 >= 120, true);
});
