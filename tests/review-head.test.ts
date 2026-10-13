import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentReviewHead } from '../lib/review-head.ts';

test('accepts a review result for the current PR head', () => {
  assert.equal(isCurrentReviewHead('abc123', 'abc123'), true);
});

test('rejects a review result after the PR head changed', () => {
  assert.equal(isCurrentReviewHead('abc123', 'def456'), false);
});

test('rejects a review result when the current PR head is unavailable', () => {
  assert.equal(isCurrentReviewHead('abc123', undefined), false);
});