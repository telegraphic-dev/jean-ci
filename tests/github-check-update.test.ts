import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCheck } from '../lib/github.ts';

for (const failures of [1, 3, 4]) {
  test(`check PATCH retries ${failures} read-after-create 404s without recreating anything`, async () => {
    const calls: any[] = [];
    const error = Object.assign(new Error('Not Found'), { status: 404 });
    const octokit = { request: async (...args: any[]) => {
      calls.push(args);
      if (calls.length <= failures) throw error;
      return { data: { id: 42 } };
    } };
    const request = updateCheck(octokit, 'owner', 'repo', 42, { status: 'in_progress' }, { retryDelayMs: 0 });
    if (failures === 4) await assert.rejects(request, e => e === error);
    else assert.deepEqual(await request, { id: 42 });
    assert.equal(calls.length, Math.min(failures + 1, 4));
    for (const [route, params] of calls) {
      assert.equal(route, 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}');
      assert.deepEqual(params, { owner: 'owner', repo: 'repo', check_run_id: 42, status: 'in_progress' });
    }
  });
}
for (const status of [401, 403, 422]) {
  test(`check PATCH does not retry HTTP ${status}`, async () => {
    let calls = 0;
    await assert.rejects(updateCheck({ request: async () => { calls++; throw { status }; } }, 'owner', 'repo', 42, {}, { retryDelayMs: 0 }));
    assert.equal(calls, 1);
  });
}
