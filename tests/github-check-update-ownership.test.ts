import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCheck } from '../lib/github.ts';

for (const updates of [{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]) {
  test(`check PATCH rechecks ownership before every ${JSON.stringify(updates)} attempt`, async () => {
    let owned = true, calls = 0, guards = 0;
    const lost = new Error('owner lost');
    await assert.rejects(updateCheck({ request: async () => {
      calls++;
      setTimeout(() => { owned = false; }, 0);
      throw Object.assign(new Error('Not Found'), { status: 404 });
    } }, 'owner', 'repo', 42, updates, {
      retryDelayMs: 20,
      beforeAttempt: async () => { guards++; if (!owned) throw lost; },
    }), error => error === lost);
    assert.equal(calls, 1, 'no new PATCH after ownership loss during backoff');
    assert.equal(guards, 2);
  });
}

test('check PATCH checks ownership before the initial request and does not retry guard errors', async () => {
  let calls = 0, guards = 0;
  const lost = Object.assign(new Error('owner lost'), { status: 404 });
  await assert.rejects(updateCheck({ request: async () => { calls++; } }, 'owner', 'repo', 42, {}, {
    retryDelayMs: 0,
    beforeAttempt: async () => { guards++; throw lost; },
  }), error => error === lost);
  assert.equal(calls, 0);
  assert.equal(guards, 1);
});
