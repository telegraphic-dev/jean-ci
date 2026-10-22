import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReviewResponse, combineChunkedReviewResponses, buildPRReviewBody, linkReviewedLocations, readableReviewSummary } from '../lib/review-output.ts';
import { SYSTEM_PROMPT } from '../lib/review-request.ts';
import { actualReviewerOutput, actualSource, historicalSummary, legacyFinding, structuredOutput, syntheticSource } from './fixtures/readable-review.ts';

test('structured Markdown remains intact, without profile/verdict/chunk noise', () => {
  const parsed = parseReviewResponse(structuredOutput);
  assert.match(parsed.reviewMarkdown, /^### Failed sends/);
  assert.match(parsed.reviewMarkdown, /\n\n\*\*Problem:\*\*/);
  assert.match(parsed.reviewMarkdown, /- Preserve the response:\n  Keep continuation indentation\./);
  assert.match(parsed.reviewMarkdown, /```ts\n  return \{ isError: response.isError \};\n```/);
  assert.doesNotMatch(parsed.reviewMarkdown, /Review profile|VERDICT:/);
  assert.match(parsed.normalized, /Review profile/);
  const body = buildPRReviewBody(parsed, syntheticSource, 'https://example.test/checks/1');
  assert.match(body, new RegExp('/blob/' + actualSource.headSha + '/src/send.ts#L42'));
});

test('verbatim historical example loses no substantive detail or invents a title/location', () => {
  const body = buildPRReviewBody(parseReviewResponse(actualReviewerOutput), actualSource, 'https://jean-ci.telegraphic.app/checks/4934');
  assert.equal(body + '\n', readFileSync(new URL('../docs/review-output-example.md', import.meta.url), 'utf8'));
  assert.ok(body.includes(legacyFinding));
  assert.doesNotMatch(body, /425|###|\/blob\/|Review profile|VERDICT:|3\/14/);
  const historical = readableReviewSummary(historicalSummary);
  assert.equal(historical, '- ' + legacyFinding);
});

test('fences, profile-like prose, inline verdict explanations and blank lines are retained', () => {
  const raw = '**VERDICT: FAIL** - Missing authorization.\n\nParagraph.\n\n~~~md\n- Review profile: diff=reviewed\n~~~\n\nReview profile: inspection was blocked, but the handler demonstrably lacks auth.';
  const parsed = parseReviewResponse(raw);
  assert.match(parsed.reviewMarkdown, /^Missing authorization\.\n\nParagraph\./);
  assert.match(parsed.reviewMarkdown, /~~~md\n- Review profile: diff=reviewed\n~~~/);
  assert.match(parsed.reviewMarkdown, /handler demonstrably lacks auth/);
});

test('aggregation retains all full findings beyond preview truncation and separates failures', () => {
  const long = parseReviewResponse('VERDICT: FAIL\n' + 'Problem details. '.repeat(5000) + '\n### TAIL FINDING\nFix this too.');
  assert.doesNotMatch(long.summary, /TAIL FINDING/);
  const combined = combineChunkedReviewResponses([
    { label: 'pass (1/3)', parsed: parseReviewResponse('VERDICT: PASS\nSafe UI.\n- Review profile: diff=reviewed; repository=not needed; tests=not needed.') },
    { label: 'first (2/3)', parsed: long },
    { label: 'last (3/3)', parsed: parseReviewResponse(structuredOutput) },
  ]);
  assert.equal(readableReviewSummary(combined.normalized), combined.reviewMarkdown);
  assert.equal(combined.verdict, 'FAIL');
  assert.match(combined.normalized, /TAIL FINDING/);
  assert.match(combined.normalized, /pass \(1\/3\)/);
  assert.match(combined.reviewMarkdown, /TAIL FINDING[\s\S]*---[\s\S]*### Failed sends/);
  assert.doesNotMatch(combined.reviewMarkdown, /Safe UI|Review profile|VERDICT:|2\/3/);
  const body = buildPRReviewBody(combined, syntheticSource, 'https://example.test/checks/1');
  assert.ok(body.length <= 65000);
  assert.match(body, /remaining findings are available in full details/);
});

test('links require safe repository/SHA and provided, diff-verified file/line locations', () => {
  for (const overrides of [{ owner: 'evil/owner' }, { repo: '..' }, { repo: 'repo?q=x' }, { headSha: 'main' }, { headSha: actualSource.headSha + '/evil' }]) {
    assert.equal(linkReviewedLocations('src/send.ts:42', { ...syntheticSource, ...overrides }), 'src/send.ts:42');
  }
  const unknown = 'src/send.ts:43 src/missing.ts:42 src/send.ts src/send.ts:0 src/send.ts:042 src/send.ts:42abc https://evil.test/src/send.ts:42';
  assert.equal(linkReviewedLocations(unknown, syntheticSource), unknown);
  assert.equal(linkReviewedLocations('```\nsrc/send.ts:42\n```', syntheticSource), '```\nsrc/send.ts:42\n```');
  assert.equal(linkReviewedLocations('[src/send.ts:42](https://example.test)', syntheticSource), '[src/send.ts:42](https://example.test)');
  const special = { ...syntheticSource, diff: "diff --git a/src/a b.ts b/src/a b.ts\n+++ b/src/a b.ts\n@@ -1 +1 @@\n+new\n" };
  assert.match(linkReviewedLocations('`src/a b.ts:1`', special), /src\/a%20b.ts#L1/);
  assert.doesNotMatch(linkReviewedLocations('`../bad.ts:1`', { ...special, diff: '+++ b/../bad.ts\n@@ -1 +1 @@\n+bad' }), /github.com/);
});

test('metadata-only fenced FAIL remains an execution error', () => {
  assert.throws(() => parseReviewResponse('VERDICT: FAIL\n```md\nReview profile: diff=reviewed; repository=blocked; tests=blocked.\n```'), /FAIL must include an explanation/);
});

test('persisted diagnostic grouping never changes headings or verdicts inside fences', () => {
  const markdown = '### Real finding\n\n```md\n## example (1/2)\nVERDICT: PASS\n- Review profile: diff=reviewed\n```\n\nFix the missing authorization.';
  const parsed = parseReviewResponse('VERDICT: FAIL\n' + markdown);
  const combined = combineChunkedReviewResponses([
    { label: 'backend (1/2)', parsed },
    { label: 'frontend (2/2)', parsed: parseReviewResponse('VERDICT: PASS\nSafe UI.') },
  ]);
  assert.equal(readableReviewSummary(combined.normalized), markdown);
});

test('overflow notices stay outside code fences and location verification ignores fake added headers', () => {
  const parsed = parseReviewResponse('VERDICT: FAIL\n### Defect\n\n```ts\n' + 'code();\n'.repeat(10000) + '```\nTAIL');
  const body = buildPRReviewBody(parsed, syntheticSource, 'https://example.test/checks/1');
  assert.ok(body.length <= 65000);
  assert.doesNotMatch(body, /```/);
  assert.match(body, /remaining findings/);
  assert.match(parsed.normalized, /TAIL/);
  const source = { ...syntheticSource, diff: 'diff --git a/src/send.ts b/src/send.ts\n+++ b/src/send.ts\n@@ -1 +1,2 @@\n+++ b/evil.ts\n+another\n' };
  assert.equal(linkReviewedLocations('evil.ts:1', source), 'evil.ts:1');
  assert.match(linkReviewedLocations('src/send.ts:1-2', source), /#L1-L2/);
});

test('prompt requests evidence-grounded structured findings without arbitrary finding count', () => {
  assert.match(SYSTEM_PROMPT, /concise descriptive ### heading/);
  for (const label of ['Location', 'Problem', 'Fix']) assert.ok(SYSTEM_PROMPT.includes('**' + label + '**'));
  assert.match(SYSTEM_PROMPT, /without inventing a line number/);
  assert.match(SYSTEM_PROMPT, /Include every blocking finding/);
  assert.doesNotMatch(SYSTEM_PROMPT, /2-5|bullet points max/);
});
