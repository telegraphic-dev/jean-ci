import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldQueueDraftPRReview } from '../lib/draft-review.ts';

test('queues the first review for a draft PR', () => {
  assert.equal(shouldQueueDraftPRReview({
    draftReviewed: false,
    headSha: 'first-sha',
  }), true);
});

test('does not repeat a draft PR review for the same head SHA', () => {
  assert.equal(shouldQueueDraftPRReview({
    draftReviewed: true,
    lastReviewedSha: 'same-sha',
    headSha: 'same-sha',
  }), false);
});

test('queues a draft PR review after a new commit', () => {
  assert.equal(shouldQueueDraftPRReview({
    draftReviewed: true,
    lastReviewedSha: 'old-sha',
    headSha: 'new-sha',
  }), true);
});