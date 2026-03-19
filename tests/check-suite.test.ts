import test from 'node:test';
import assert from 'node:assert/strict';
import { handlesCheckSuiteAction, shouldQueueRerequestedReview } from '../lib/check-suite.ts';

test('handlesCheckSuiteAction supports completed and rerequested', () => {
  assert.equal(handlesCheckSuiteAction('completed'), true);
  assert.equal(handlesCheckSuiteAction('rerequested'), true);
  assert.equal(handlesCheckSuiteAction('requested'), false);
});

test('shouldQueueRerequestedReview only queues when PR review is enabled', () => {
  assert.equal(shouldQueueRerequestedReview(true), true);
  assert.equal(shouldQueueRerequestedReview(false), false);
  assert.equal(shouldQueueRerequestedReview(null), false);
  assert.equal(shouldQueueRerequestedReview(undefined), false);
});

