import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('failed check publication terminalizes locally, queues exact public output, and never replays a review', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', String.raw`
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    const moduleUrl = name => new URL('../lib/' + name + '.ts', ${JSON.stringify(import.meta.url)}).href;
    let local = {};
    let calls = [], reviews = [], runs = 0, failStart = true;
    mock.module(moduleUrl('db'), { namedExports: {
      getRepo: async () => ({ pr_review_enabled: true }),
      getConfig: async () => 'Review', DEFAULT_USER_PROMPT: 'Review',
      insertCheckRun: async () => 5879, setCheckRunGithubId: async () => {}, setReservedCheckInput: async () => {},
      updateCheckRun: async (_id, data) => { local = { ...local, ...data }; },
    }});
    mock.module(moduleUrl('github'), { namedExports: {
      getInstallationOctokit: async () => ({}), fetchPRCheckFiles: async () => [],
      getPRInfo: async () => ({ title: 'Example', head: { sha: 'head' }, base: { sha: 'base' } }),
      getPRDiff: async () => 'diff', createCheck: async () => ({ id: 131716179355 }),
      updateCheck: async (...args) => {
        const update = args[4]; calls.push(update);
        if (update.status === 'in_progress' && !failStart) return;
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
      createPRReview: async (...args) => { reviews.push(args); },
    }});
    mock.module(moduleUrl('llm'), { namedExports: {
      callOpenClaw: async () => { runs++; return { success: true, response: 'VERDICT: PASS\nPRIVATE_DIAGNOSTIC_SCOPE' }; },
    }});
    const { runPRReview } = await import(moduleUrl('pr-review'));
    await runPRReview(1, 'owner', 'repo', 342, 'head');
    assert.equal(local.status, 'completed');
    assert.equal(local.conclusion, 'failure');
    assert.ok(local.completed_at instanceof Date);
    assert.equal(local.github_completion.status, 'completed');
    assert.equal(local.github_completion.conclusion, 'failure');
    assert.equal(runs, 0); assert.equal(reviews.length, 0);
    // Once the reviewer has produced a verdict, failed publication must not
    // turn PASS into a generic failure or publish a second approval.
    failStart = false; local = {}; calls = [];
    await runPRReview(1, 'owner', 'repo', 342, 'head');
    assert.equal(runs, 1); assert.equal(reviews.length, 1);
    assert.equal(local.conclusion, 'success');
    assert.match(local.summary, /PRIVATE_DIAGNOSTIC_SCOPE/);
    assert.equal(local.github_completion.conclusion, 'success');
    assert.doesNotMatch(local.github_completion.output.summary, /PRIVATE_DIAGNOSTIC_SCOPE/);
    assert.equal(calls.filter(c => c.status === 'completed').length, 1);
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});
