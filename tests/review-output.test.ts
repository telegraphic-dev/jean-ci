import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptValidationSummary, combineChunkedReviewResponses, parseReviewResponse, validateReviewPrompt } from '../lib/review-output.ts';

test('validateReviewPrompt accepts structured prompt', () => {
  const result = validateReviewPrompt(`
# Security Review

## Purpose
Catch security regressions.

## Review Instructions
Review the diff for auth bugs and exposed secrets.

## Verdict Criteria
- PASS when no blocking security issues are found.
- FAIL when the diff introduces a real vulnerability.
`);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateReviewPrompt reports actionable errors', () => {
  const result = validateReviewPrompt('Review this quickly');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Review Instructions')));
  assert.ok(buildPromptValidationSummary(result.errors).includes('Fix the prompt file and push again'));
});

test('parseReviewResponse normalizes bullet output', () => {
  const parsed = parseReviewResponse(`VERDICT: FAIL

- Missing auth check on admin route
- Secret committed in config example`);

  assert.equal(parsed.verdict, 'FAIL');
  assert.equal(parsed.title, '❌ Changes requested');
  assert.ok(parsed.summary.startsWith('VERDICT: FAIL'));
  assert.ok(parsed.normalized.includes('- Missing auth check on admin route'));
});

test('parseReviewResponse accepts verdict line with trailing explanation', () => {
  const parsed = parseReviewResponse(`VERDICT: PASS - no blocking issues found

Everything critical looks covered.`);

  assert.equal(parsed.verdict, 'PASS');
  assert.equal(parsed.title, '✅ Approved');
  assert.ok(parsed.normalized.includes('\n\nEverything critical looks covered.'));
});

test('parseReviewResponse requires verdict on first non-empty line', () => {
  assert.throws(
    () => parseReviewResponse('Looks good\nVERDICT: PASS'),
    /must start with "VERDICT: PASS" or "VERDICT: FAIL"/
  );
});

test('parseReviewResponse preserves prose and continuations alongside metadata', () => {
  const parsed = parseReviewResponse(`VERDICT: FAIL

The registration endpoint permanently exhausts its global client limit.
- Persist an expiry and reclaim expired registrations.
  Rate limiting alone does not recover capacity.
- Review profile: diff=reviewed; repository=inspected; tests=not needed.`);
  assert.match(parsed.summary, /registration endpoint permanently exhausts/);
  assert.match(parsed.summary, /Persist an expiry/);
  assert.match(parsed.summary, /Rate limiting alone/);
});

test('parseReviewResponse retains explanations on the verdict line', () => {
  const parsed = parseReviewResponse('**VERDICT: FAIL** - Authorization is missing.\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.');
  assert.match(parsed.summary, /Authorization is missing/);
});

test('parseReviewResponse rejects empty and profile-only failures', () => {
  for (const details of ['', '- Review profile: diff=reviewed; repository=inspected; tests=not needed.', '**Review profile:** diff=reviewed; repository=blocked; tests=blocked.']) {
    assert.throws(() => parseReviewResponse(`VERDICT: FAIL\n\n${details}`), /FAIL must include an explanation beyond review profile metadata/);
  }
});

test('parseReviewResponse rejects wrapped profiles and Markdown-only details', () => {
  for (const details of [
    '- Review profile:\n  diff=reviewed; repository=inspected; tests=not needed.',
    '- Review profile: diff=reviewed; repository=inspected; tests=not needed.\n---',
    '### Review profile:\n- diff=reviewed\n- repository=inspected\n- tests=not needed.\n***',
  ]) {
    assert.throws(() => parseReviewResponse(`VERDICT: FAIL\n${details}`), /FAIL must include an explanation/);
  }
});

test('parseReviewResponse retains a substantive heading-form finding', () => {
  const parsed = parseReviewResponse('VERDICT: FAIL\n### Authorization is missing in lib/api.ts:42\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.');
  assert.match(parsed.summary, /Authorization is missing in lib\/api.ts:42/);
});

test('parseReviewResponse preserves findings beyond the fifth line', () => {
  const parsed = parseReviewResponse(`VERDICT: FAIL\n${Array.from({ length: 8 }, (_, i) => `- Finding ${i + 1}`).join('\n')}`);
  assert.match(parsed.summary, /Finding 8/);
});

test('combineChunkedReviewResponses retains late findings and prose', () => {
  const combined = combineChunkedReviewResponses([
    { label: 'dashboard (1/2)', parsed: parseReviewResponse(`VERDICT: FAIL\n${Array.from({ length: 13 }, (_, i) => `- Finding ${i + 1}`).join('\n')}`) },
    { label: 'dashboard (2/2)', parsed: parseReviewResponse('VERDICT: FAIL\nCritical authorization issue in the last segment.\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.') },
  ]);
  assert.match(combined.summary, /Finding 13/);
  assert.match(combined.normalized, /## dashboard \(2\/2\)\n\nVERDICT: FAIL\n\nCritical authorization issue/);
  assert.match(combined.reviewMarkdown, /Critical authorization issue/);
  assert.doesNotMatch(combined.reviewMarkdown, /dashboard|Review profile|VERDICT:/);
});

test('combineChunkedReviewResponses fails the whole review when any subsystem fails', () => {
  const combined = combineChunkedReviewResponses([
    { label: 'frontend (1/2)', parsed: parseReviewResponse('VERDICT: PASS\n- UI is safe') },
    { label: 'backend (2/2)', parsed: parseReviewResponse('VERDICT: FAIL\n- Authorization is missing') },
  ]);

  assert.equal(combined.verdict, 'FAIL');
  assert.match(combined.normalized, /## backend \(2\/2\)/);
  assert.match(combined.reviewMarkdown, /Authorization is missing/);
  assert.doesNotMatch(combined.reviewMarkdown, /UI is safe/);
});
