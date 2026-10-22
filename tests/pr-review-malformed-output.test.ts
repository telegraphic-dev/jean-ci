import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate module mocks in a child so the normal test runner needs no global
// experimental flags, credentials, database, or network access.
test('PR reviews report malformed output without requesting changes and preserve prior findings', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--experimental-test-module-mocks', '--loader', new URL('./support/tsx-loader.mjs', import.meta.url).href, '--input-type=module', '-e', String.raw`
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
    let stored = [];
    let currentHead = 'head';
    const moduleUrl = (name) => new URL('../lib/' + name + '.ts', ${JSON.stringify(import.meta.url)}).href;
    mock.module(moduleUrl('db'), { namedExports: {
      getRepo: async () => ({ pr_review_enabled: true }),
      getConfig: async () => configuredPrompt, DEFAULT_USER_PROMPT: 'Review',
      insertCheckRun: async () => 1, setCheckRunGithubId: async () => {},
      setReservedCheckInput: async () => { throw new Error('Ordinary review must not update a reserved restart'); },
      updateCheckRun: async (...args) => { stored.push(args.at(-1)); },
    }});
    mock.module(moduleUrl('github'), { namedExports: {
      getInstallationOctokit: async () => ({}), fetchPRCheckFiles: async () => [],
      getPRInfo: async () => ({ title: 'Example', head: { sha: currentHead }, base: { sha: 'base' } }),
      getPRDiff: async () => reviewDiff, createCheck: async () => ({ id: 1 }),
      updateCheck: async (...args) => { updates.push(args.at(-1)); },
      createPRReview: async (...args) => { reviews.push(args); },
    }});
    mock.module(moduleUrl('llm'), { namedExports: {
      callOpenClaw: async (prompt, context) => { sent.push({ prompt, context }); const response = responses.shift(); return typeof response === 'object' ? response : { success: true, response }; },
    }});
    mock.module(moduleUrl('review-context'), { namedExports: {
      truncateReviewDiff: (diff) => diff,
      buildReviewContexts: (input) => useRealContexts ? actualContexts.buildReviewContexts(input) : responses.map((_, i) => ({ label: 'segment ' + i + ' (' + (i + 1) + '/' + responses.length + ')', context: 'diff' })),
    }});
    const { runPRReview } = await import(moduleUrl('pr-review'));
    const malformed = 'VERDICT: FAIL\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.';
    responses = [malformed];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.title, /Review failed/);
    assert.match(stored.at(-1).summary, /FAIL must include an explanation/);

    const incomplete = 'VERDICT: INCOMPLETE\nRequired cross-segment context could not be fetched because tool approval was denied.';
    for (const earlier of [[], ['VERDICT: PASS\nNo defects.']]) {
      updates = [];
      responses = [...earlier, incomplete];
      await runPRReview(1, 'owner', 'repo', 1, 'head');
      assert.equal(reviews.length, 0);
      assert.equal(updates.at(-1).conclusion, 'failure');
      assert.match(stored.at(-1).summary, /INCOMPLETE/);
      assert.match(stored.at(-1).summary, /tool approval was denied/);
    }
    updates = [];
    responses = ['VERDICT: FAIL\nAuthorization is missing in api.ts.', malformed];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.summary, /Authorization is missing/);
    assert.match(updates.at(-1).output.summary, /remaining segments stopped/);
    assert.match(stored.at(-1).summary, /FAIL must include an explanation/);
    responses = ['VERDICT: FAIL\nAuthorization is missing in api.ts.', incomplete];
    await runPRReview(1, 'owner', 'repo', 1, 'head');
    assert.equal(reviews.length, 0);
    assert.equal(updates.at(-1).conclusion, 'failure');
    assert.match(updates.at(-1).output.summary, /Authorization is missing/);
    assert.match(stored.at(-1).summary, /INCOMPLETE/);

    const { readableReviewSummary, REVIEW_INTERRUPTION_NOTICE } = await import(moduleUrl('review-output'));
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { CheckReviewContent } = await import(new URL('../components/CheckReviewContent.tsx', ${JSON.stringify(import.meta.url)}).href);
    for (const passing of [[], ['VERDICT: PASS\nSUCCESSFUL_SEGMENT_ONLY']]) {
      const count = reviews.length;
      responses = ['VERDICT: FAIL\n### Genuine defect\nAuthorization is missing in api.ts.', ...passing, incomplete];
      await runPRReview(1, 'owner', 'repo', 1, 'head');
      assert.equal(reviews.length, count, 'unfinished reviews must not publish a PR verdict');
      const summary = stored.at(-1).summary;
      const readable = readableReviewSummary(summary);
      assert.equal(readable, '### Genuine defect\nAuthorization is missing in api.ts.\n\n' + REVIEW_INTERRUPTION_NOTICE);
      assert.match(summary, /tool approval was denied/);
      assert.match(updates.at(-1).output.summary, /remaining segments stopped.*\[View full details\]\(.*\/checks\/1\)/);
      assert.doesNotMatch(updates.at(-1).output.summary, /SUCCESSFUL_SEGMENT_ONLY|INCOMPLETE|tool approval was denied/);
      const html = renderToStaticMarkup(createElement(CheckReviewContent, { summary, repo: 'owner/repo', headSha: 'head' }));
      const visible = html.split('<details')[0];
      assert.match(visible, /Genuine defect/);
      assert.ok(visible.includes(REVIEW_INTERRUPTION_NOTICE));
      assert.doesNotMatch(visible, /SUCCESSFUL_SEGMENT_ONLY|tool approval was denied|VERDICT:/);
      const disclosure = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
      assert.match(disclosure, /Review details/);
      assert.match(disclosure, /tool approval was denied/);
      assert.doesNotMatch(disclosure, /<details[^>]*\bopen\b/);
      if (passing.length) assert.match(disclosure, /SUCCESSFUL_SEGMENT_ONLY/);
    }

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

    useRealContexts = false;
    configuredPrompt = 'Review';
    const fixture = await import(new URL('./fixtures/readable-review.ts', ${JSON.stringify(import.meta.url)}).href);
    currentHead = fixture.syntheticSource.headSha;
    reviewDiff = fixture.syntheticSource.diff;
    for (const preceding of [[], ['VERDICT: PASS\nNo blocking UI defects.'], ['VERDICT: FAIL\n### Another defect\nProblem and fix.']]) {
      responses = [...preceding, fixture.structuredOutput];
      await runPRReview(1, 'owner', 'repo', 1, currentHead);
      const review = reviews.at(-1);
      assert.equal(review[4], 'REQUEST_CHANGES');
      assert.equal(review[6], currentHead);
      assert.match(review[5], /### Failed sends are reported as successful/);
      assert.match(review[5], /\*\*Problem:\*\*/);
      assert.match(review[5], /\/blob\/[a-f0-9]{40}\/src\/send.ts#L42/);
      assert.match(review[5], /\n  Keep continuation indentation/);
      assert.doesNotMatch(review[5], /VERDICT:|Review profile|segment \d|No blocking UI/);
      if (preceding[0]?.includes('FAIL')) assert.match(review[5], /### Another defect/);
      assert.doesNotMatch(updates.at(-1).output.summary, /VERDICT:|Review profile|segment \d|No blocking UI/);
      assert.match(updates.at(-1).output.summary, /### Failed sends are reported as successful/);
      if (preceding[0]?.includes('FAIL')) assert.match(updates.at(-1).output.summary, /### Another defect/);
      assert.match(stored.at(-1).summary, /Review profile/);
      if (preceding.length) assert.match(stored.at(-1).summary, /segment 0/);
    }
    // Public checks and authenticated diagnostics are independently captured.
    for (const preceding of [[], ['VERDICT: PASS\nSafe UI.\nReview profile: diff=reviewed; repository=blocked; tests=blocked.']]) {
      responses = [...preceding, 'VERDICT: FAIL\n### Defect\nProblem details.\n\nFix the sender.\nReview profile: diff=reviewed; repository=blocked; tests=blocked.'];
      await runPRReview(1, 'owner', 'repo', 1, currentHead);
      assert.equal(updates.at(-1).output.summary, '### Defect\nProblem details.\n\nFix the sender.');
      assert.match(stored.at(-1).summary, /VERDICT: FAIL/);
      assert.match(stored.at(-1).summary, /Review profile/);
      if (preceding.length) assert.match(stored.at(-1).summary, /Safe UI/);
    }
    responses = ['VERDICT: PASS\nSafe UI.\nReview profile: diff=reviewed; repository=blocked; tests=blocked.', 'VERDICT: PASS\nSafe API.'];
    await runPRReview(1, 'owner', 'repo', 1, currentHead);
    assert.equal(updates.at(-1).output.summary, 'Safe UI.\n\n---\n\nSafe API.');
    assert.match(stored.at(-1).summary, /segment 0[\s\S]*Review profile[\s\S]*segment 1/);
    for (const failure of [malformed, incomplete, { success: false, errorType: 'gateway', error: 'PRIVATE_GATEWAY_DETAIL' }]) {
      responses = ['VERDICT: PASS\nSafe UI.\nReview profile: diff=reviewed; repository=blocked; tests=blocked.', fixture.structuredOutput, failure];
      await runPRReview(1, 'owner', 'repo', 1, currentHead);
      assert.match(updates.at(-1).output.summary, /### Failed sends are reported as successful/);
      assert.match(updates.at(-1).output.summary, /\*\*Problem:\*\*/);
      assert.match(updates.at(-1).output.summary, /remaining segments stopped/);
      assert.doesNotMatch(updates.at(-1).output.summary, /VERDICT:|Review profile|segment \d|Safe UI|PRIVATE_GATEWAY_DETAIL/);
      assert.match(stored.at(-1).summary, /Safe UI/);
      assert.match(stored.at(-1).summary, /Review profile/);
      if (typeof failure === 'object') assert.match(stored.at(-1).summary, /PRIVATE_GATEWAY_DETAIL/);
    }
    responses = ['VERDICT: FAIL\n' + 'Finding detail. '.repeat(5000) + '\nTAIL_FINDING', fixture.structuredOutput];
    await runPRReview(1, 'owner', 'repo', 1, currentHead);
    assert.match(stored.at(-1).summary, /TAIL_FINDING/);
    assert.ok(stored.at(-1).summary.length > 65535);
    assert.ok(updates.at(-1).output.summary.length <= 65535);
    assert.match(reviews.at(-1)[5], /remaining findings are available in full details/);
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});
