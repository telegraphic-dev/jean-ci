import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionFailureOutcome } from '../lib/review-failure.ts';

test('buildExecutionFailureOutcome marks gateway errors as neutral', () => {
  const result = buildExecutionFailureOutcome('gateway', 'timeout');

  assert.equal(result.conclusion, 'neutral');
  assert.equal(result.title, '⚠️ Review unavailable');
  assert.ok(result.summary.includes('marked neutral'));
});

test('buildExecutionFailureOutcome marks unknown errors as failure', () => {
  const result = buildExecutionFailureOutcome('unknown', 'bad payload');

  assert.equal(result.conclusion, 'failure');
  assert.equal(result.title, '❌ Review failed');
  assert.ok(result.summary.includes('Reviewer execution failed'));
});
