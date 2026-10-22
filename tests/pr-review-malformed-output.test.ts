import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate module mocks in a child so the normal test runner needs no global
// experimental flags, credentials, database, or network access.
test('PR reviews report malformed output without requesting changes and preserve prior findings', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', String.raw`
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    let responses = [];
    let useRealContexts = false;
    let reviewDiff = 'diff';
    let configuredPrompt = 'Review';
    let sent = [];
    const actualContexts = await import(new URL('../lib/review-context.ts', ${JSON.stringify(import.meta.url)}).href);
    let updates = [];
    let reviews = [];
    const moduleUrl = (name) => new URL('../lib/' + name + '.ts', ${JSON.stringify(import.meta.url)}).href;
    mock.module(moduleUrl('db'), { namedExports: {
      getRepo: async () => ({ pr_review_enabled: true }),
      getConfig: async () => configuredPrompt, DEFAULT_USER_PROMPT: 'Review',
      insertCheckRun: async () => 1, setCheckRunGithubId: async () => {},
      updateCheckRun: async () => {},
    }});
    mock.module(moduleUrl('github'), { namedExports: {
      getInstallationOctokit: async () => ({}), fetchPRCheckFiles: async () => [],
      getPRInfo: async () => ({ title: 'Example', head: { sha: 'head' }, base: { sha: 'base' } }),
      getPRDiff: async () => reviewDiff, createCheck: async () => ({ id: 1 }),
      updateCheck: async (...args) => { updates.push(args.at(-1)); },
      createPRReview: async (...args) => { reviews.push(args); },
    }});
    mock.module(moduleUrl('llm'), { namedExports: {
      callOpenClaw: async (prompt, context) => { sent.push({ prompt, context }); return { success: true, response: responses.shift() }; },
    }});
    mock.module(moduleUrl('review-context'), { namedExports: {
      truncateReviewDiff: (diff) => diff,
      buildReviewContexts: (input) => useRealContexts ? actualContexts.buildReviewContexts(input) : responses.map((_, i) => ({ label: 'segment ' + i, context: 'diff' })),
    }});
    const { runPRReview } = await import(moduleUrl('pr-review'));
    const malformed = 'VERDICT: FAIL\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.';
    responses = [malformed];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.title, /Review failed/);
    assert.match(updates.at(-1).output.summary, /FAIL must include an explanation/);

    const incomplete = 'VERDICT: INCOMPLETE\nRequired cross-segment context could not be fetched because tool approval was denied.';
    for (const earlier of [[], ['VERDICT: PASS\nNo defects.']]) {
      updates = [];
      responses = [...earlier, incomplete];
      await runPRReview(1, 'owner', 'repo', 1, 'head');
      assert.equal(reviews.length, 0);
      assert.equal(updates.at(-1).conclusion, 'failure');
      assert.match(updates.at(-1).output.summary, /INCOMPLETE/);
      assert.match(updates.at(-1).output.summary, /tool approval was denied/);
    }
    updates = [];
    responses = ['VERDICT: FAIL\nAuthorization is missing in api.ts.', malformed];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.summary, /Authorization is missing/);
    assert.match(updates.at(-1).output.summary, /remaining segments stopped/);
    assert.match(updates.at(-1).output.summary, /FAIL must include an explanation/);
    responses = ['VERDICT: FAIL\nAuthorization is missing in api.ts.', incomplete];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.summary, /Authorization is missing/);
    assert.match(updates.at(-1).output.summary, /INCOMPLETE/);

    useRealContexts = true;
    reviewDiff = 'diff --git a/app/dashboard.ts b/app/dashboard.ts\n@@ -1 +1 @@\n' + '+changed line\n'.repeat(14000) + '+TAIL_SENTINEL\n';
    configuredPrompt = 'Review security. '.repeat(800);
    responses = Array(100).fill('VERDICT: PASS\nNo blocking defects.');
    sent = [];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.ok(sent.length > 3);
    const { assertReviewRequestFits } = await import(new URL('../lib/review-request.ts', ${JSON.stringify(import.meta.url)}).href);
    for (const request of sent) assertReviewRequestFits(request.prompt, request.context);
    assert.ok(sent.at(-1).context.includes('+TAIL_SENTINEL'));
    assert.equal(updates.at(-1).conclusion, 'success');
    assert.equal(reviews.at(-1)[4], 'APPROVE');
    const reviewCount = reviews.length;
    sent = [];
    configuredPrompt = 'X'.repeat(60000);
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(sent.length, 0);
    assert.equal(reviews.length, reviewCount);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.summary, /transport budget/);
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});
