import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewContext, buildReviewContexts, splitReviewDiffBySubsystem } from '../lib/review-context.ts';
import { SYSTEM_PROMPT, REVIEW_REQUEST_LIMIT, reviewRequestLength, assertReviewRequestFits } from '../lib/review-request.ts';
import { parseReviewResponse } from '../lib/review-output.ts';
import { runLocalReview } from '../lib/local-review.ts';
import { callOpenClaw, __internal } from '../lib/llm.ts';

const dashboard = 'diff --git a/app/dashboard/page.tsx b/app/dashboard/page.tsx\n--- a/app/dashboard/page.tsx\n+++ b/app/dashboard/page.tsx\n@@ -1 +1,4000 @@\n'
  + Array.from({ length: 4000 }, (_, i) => `+const row${i} = "${'x'.repeat(22)}";\n`).join('') + '+TAIL_SENTINEL\n';
function payload(context: string) {
  const start = context.indexOf('## Diff\n```diff\n') + '## Diff\n```diff\n'.length;
  const end = context.lastIndexOf('\n```\n\n## End of Review Input');
  assert.ok(start > 0 && end >= start);
  return context.slice(start, end);
}

test('realistic >160k dashboard is fully covered within the assembled transport cap', () => {
  assert.ok(dashboard.length > 160_000);
  const prompt = 'Review carefully. '.repeat(450);
  const input = { title: 'Dashboard', body: 'Details '.repeat(600), owner: 'owner', repo: 'repo', diff: dashboard, diffLimit: 200_000, userPrompt: prompt };
  const contexts = buildReviewContexts(input);
  assert.ok(contexts.length > 3);
  assert.equal(contexts.map(({ context }) => payload(context)).join(''), dashboard);
  for (const { context } of contexts) {
    assert.ok(reviewRequestLength(prompt, context) <= REVIEW_REQUEST_LIMIT);
    assert.ok((SYSTEM_PROMPT + '\n\n' + prompt + '\n\n## Pull Request Details\n' + context).slice(0, 65536).endsWith('included above.'));
    assert.ok(context.startsWith('## Review Scope'));
    assert.match(context, /Intentional segment boundaries/);
    assert.match(context, /continued file\/hunk/);
    assert.match(context, /- app\/dashboard\/page.tsx/);
  }
  assert.match(payload(contexts.at(-1)!.context), /TAIL_SENTINEL/);
  const largerPrompt = buildReviewContexts({ ...input, userPrompt: prompt.repeat(3) });
  assert.ok(largerPrompt.length > contexts.length);
});

test('splitting preserves every character per subsystem, including long headers/hunks/lines', () => {
  const fixtures = [dashboard, 'diff --git a/lib/a.ts b/lib/a.ts\n' + '+😀'.repeat(1000), 'diff --git a/lib/a.ts b/lib/a.ts\n' + 'header'.repeat(1000) + '\n@@ -1 +1 @@\n+tail'];
  for (const diff of fixtures) {
    const chunks = splitReviewDiffBySubsystem(diff, 113);
    assert.equal(chunks.map((chunk) => chunk.diff).join(''), diff);
    assert.ok(chunks.every((chunk) => chunk.diff.length <= 113));
  }
  const mixed = dashboard + 'diff --git a/lib/a.ts b/lib/a.ts\n+backend\n' + 'diff --git a/app/end.ts b/app/end.ts\n+frontend-tail\n';
  const contexts = buildReviewContexts({ diff: mixed, diffLimit: 200_000 });
  const actual = contexts.map(({ context }) => payload(context)).join('');
  assert.equal(actual.length, mixed.length);
  for (const expected of splitReviewDiffBySubsystem(mixed, mixed.length)) {
    const actualSubsystem = contexts.filter(({ label }) => label.startsWith(expected.subsystem + ' (')).map(({ context }) => payload(context)).join('');
    assert.equal(actualSubsystem, expected.diff);
  }
});

test('oversized metadata and criteria fail explicitly without truncating or sending', async () => {
  for (const field of ['title', 'body', 'userPrompt'] as const) {
    assert.throws(() => buildReviewContexts({ diff: '+tail', diffLimit: 200_000, [field]: 'x'.repeat(60_000) }), /transport budget/);
  }
  assert.throws(() => buildReviewContext({ diff: 'whole diff', diffLimit: 2 }), /use buildReviewContexts/);
  for (const diffLimit of [NaN, 0, -1, Infinity]) assert.throws(() => buildReviewContexts({ diff: dashboard, diffLimit }), /limit/);
  let calls = 0;
  const oldRpc = __internal.callGatewayRpc;
  const oldFetch = globalThis.fetch;
  try {
    __internal.callGatewayRpc = async () => { calls++; throw new Error('must not send'); };
    globalThis.fetch = async () => { calls++; throw new Error('must not send'); };
    for (const [prompt, context] of [['x'.repeat(60_000), ''], ['', 'x'.repeat(60_000)]]) {
      const result = await callOpenClaw(prompt, context);
      assert.equal(result.success, false);
      assert.match(result.error!, /transport budget/);
    }
    assert.equal(calls, 0);
  } finally { __internal.callGatewayRpc = oldRpc; globalThis.fetch = oldFetch; }
  const available = REVIEW_REQUEST_LIMIT - reviewRequestLength('review', '');
  assert.doesNotThrow(() => assertReviewRequestFits('review', 'x'.repeat(available)));
  assert.throws(() => assertReviewRequestFits('review', 'x'.repeat(available + 1)), /transport budget/);
});

test('INCOMPLETE is execution failure, not a code verdict, and genuine FAIL is unchanged', () => {
  assert.throws(() => parseReviewResponse('**VERDICT: INCOMPLETE**\nRequired evidence blocked by approval.'), /INCOMPLETE[\s\S]*execution did not finish/);
  assert.equal(parseReviewResponse('VERDICT: FAIL\nMissing authorization in handler.').verdict, 'FAIL');
  assert.equal(parseReviewResponse('VERDICT: PASS\nOptional test blocked; diff sufficient.').verdict, 'PASS');
  assert.match(SYSTEM_PROMPT, /blocked optional test is not INCOMPLETE/);
  assert.match(SYSTEM_PROMPT, /Never bypass tool approvals/);
});

test('local reviews aggregate all segments and retain earlier findings when review is incomplete', async () => {
  for (const mode of ['pass', 'late-fail', 'incomplete', 'fail-incomplete']) {
    const seen: string[] = [];
    const result = await runLocalReview({ repo: 'owner/repo', ref: 'main', diff: dashboard,
      __deps: {
        getUserPrompt: async () => 'Review code', fetchChecksFromGit: async () => [],
        callReviewer: async (prompt, context = '') => {
          assertReviewRequestFits(prompt, context); seen.push(payload(context));
          const verdict = mode.includes('incomplete') && seen.length === 2 ? 'INCOMPLETE'
            : mode === 'fail-incomplete' && seen.length === 1 || mode === 'late-fail' && context.includes('+TAIL_SENTINEL') ? 'FAIL' : 'PASS';
          return { success: true, response: `VERDICT: ${verdict}\n${verdict === 'FAIL' ? 'Concrete authorization defect.' : 'Review evidence status.'}` };
        },
      },
    });
    if (mode.includes('incomplete')) {
      assert.equal(result.executionFailures.length, 1);
      assert.match(result.executionFailures[0].error, /INCOMPLETE/);
      assert.equal(result.checks.length, mode === 'fail-incomplete' ? 1 : 0);
    } else {
      assert.equal(seen.join(''), dashboard);
      assert.equal(result.executionFailures.length, 0);
      assert.equal(result.checks[0].verdict, mode === 'pass' ? 'PASS' : 'FAIL');
    }
    if (mode === 'fail-incomplete') assert.match(result.checks[0].summary, /Concrete authorization defect/);
  }
});


test('file lists over 200 entries remain visible and oversized overrides cannot lift the cap', () => {
  const files = Array.from({ length: 250 }, (_, i) => `lib/file-${i}.ts`);
  const diff = files.map((path) => `diff --git a/${path} b/${path}\n+change\n`).join('');
  const contexts = buildReviewContexts({ diff, diffLimit: 1_000_000 });
  const combined = contexts.map(({ context }) => context).join('\n');
  for (const path of files) assert.ok(combined.includes(`- ${path}\n`));
  assert.doesNotMatch(combined, /more files omitted/);
  const large = buildReviewContexts({ diff: dashboard, diffLimit: 1_000_000 });
  assert.ok(large.length > 1);
  assert.ok(large.every(({ context }) => reviewRequestLength('', context) <= REVIEW_REQUEST_LIMIT));
});

test('local oversized criteria produce execution failure before calling the reviewer', async () => {
  let calls = 0;
  const result = await runLocalReview({ repo: 'owner/repo', ref: 'main', diff: '+tail', __deps: {
    getUserPrompt: async () => 'x'.repeat(60_000), fetchChecksFromGit: async () => [],
    callReviewer: async () => { calls++; return { success: true, response: 'VERDICT: PASS' }; },
  } });
  assert.equal(calls, 0);
  assert.equal(result.checks.length, 0);
  assert.equal(result.executionFailures.length, 1);
  assert.match(result.executionFailures[0].error, /transport budget/);
});
