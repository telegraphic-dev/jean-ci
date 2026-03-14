import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptValidationSummary, parseReviewResponse, validateReviewPrompt } from '../lib/review-output.ts';

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
  assert.ok(parsed.normalized.includes('- Everything critical looks covered.'));
});

test('parseReviewResponse requires verdict on first non-empty line', () => {
  assert.throws(
    () => parseReviewResponse('Looks good\nVERDICT: PASS'),
    /must start with "VERDICT: PASS" or "VERDICT: FAIL"/
  );
});
