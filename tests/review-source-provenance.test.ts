import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildReviewContexts } from '../lib/review-context.ts';

// Exercise real runners -> context assembly -> callOpenClaw -> Hermes HTTP body.
// Only persistence, GitHub and the external HTTP authority are test doubles.
test('PR and local source provenance reaches every actual outbound Hermes request', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--experimental-test-module-mocks', '--input-type=module', '-e', String.raw`
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    process.env.OPENCLAW_GATEWAY_URL = 'http://reviewer.invalid';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
    process.env.OPENCLAW_USE_RUNS = 'true';
    const moduleUrl = name => new URL('../lib/' + name + '.ts', ${JSON.stringify(import.meta.url)}).href;
    const head = 'a'.repeat(40), base = 'b'.repeat(40);
    let diff = '', configuredPrompt = 'Review code', currentHead = head;
    let sent = [], promptRefs = [];
    const customPrompt = '# Security Check\n\n## Purpose\nReview security.\n\n## Review Instructions\nCheck authorization.\n\n## Verdict Criteria\nPASS if no authorization defects. FAIL if authorization bypass.';
    mock.module(moduleUrl('db'), { namedExports: {
      getRepo: async () => ({ pr_review_enabled: true }),
      getConfig: async () => configuredPrompt, DEFAULT_USER_PROMPT: 'Review code',
      insertCheckRun: async () => 1, setCheckRunGithubId: async () => {},
      setReservedCheckInput: async () => {}, updateCheckRun: async () => {},
      reviewRunStore: undefined, getJsonState: async () => null, setJsonState: async () => {},
    }});
    mock.module(moduleUrl('github'), { namedExports: {
      getInstallationOctokit: async () => ({}),
      fetchPRCheckFiles: async () => [{ name: 'security', content: customPrompt }],
      getPRInfo: async () => ({ title: 'Review fixture', head: { sha: currentHead }, base: { sha: base } }),
      getPRDiff: async () => diff, createCheck: async () => ({ id: 1 }),
      updateCheck: async () => {}, createPRReview: async () => {},
    }});
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/v1/capabilities')) return Response.json({ features: {
        run_submission: true, run_status: true, run_approval_response: true, approval_events: true,
      }});
      if (String(url).endsWith('/v1/runs') && init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ run_id: 'run-' + sent.length });
      }
      if (/\/v1\/runs\/run-\d+$/.test(String(url))) return Response.json({
        run_id: String(url).split('/').at(-1), status: 'completed', output: 'VERDICT: PASS\nNo blocking defects.',
      });
      throw new Error('Unexpected HTTP request: ' + url);
    };
    const { __internal } = await import(moduleUrl('llm'));
    __internal.isWebSocketEnabled = () => false;
    const { runPRReview } = await import(moduleUrl('pr-review'));
    const { runLocalReview } = await import(moduleUrl('local-review'));
    const { SYSTEM_PROMPT, REVIEW_REQUEST_LIMIT } = await import(moduleUrl('review-request'));
    const { splitReviewDiffBySubsystem } = await import(moduleUrl('review-context'));
    const small = 'diff --git a/lib/a.ts b/lib/a.ts\n@@ -1 +1 @@\n-old\n+UNCOMMITTED_CHANGE\n';
    const large = small + '+large line 😀\n'.repeat(10000) + '+TAIL_SENTINEL\n'
      + 'diff --git a/app/end.ts b/app/end.ts\n+frontend\n';
    const extractDiff = input => {
      const fence = String.fromCharCode(96).repeat(3);
      const marker = '## Diff\n' + fence + 'diff\n';
      const start = input.indexOf(marker) + marker.length;
      const end = input.lastIndexOf('\n' + fence + '\n\n## End of Review Input');
      assert.ok(start > 0 && end >= start);
      return input.slice(start, end);
    };
    function verifyCoverage(expected, checks) {
      // Both checks receive all source characters, even continuation segments
      // whose payload has no diff header. Group by criteria, not session metadata.
      for (const prompt of checks) {
        const requests = sent.filter(({ input }) => input.startsWith(prompt + '\n\n## Pull Request Details\n'));
        assert.ok(requests.length > (expected === small ? 0 : 1));
        const actual = requests.map(({ input }) => extractDiff(input)).join('');
        const grouped = splitReviewDiffBySubsystem(expected, expected.length).map(c => c.diff).join('');
        assert.equal(actual, grouped);
      }
      for (const request of sent) {
        assert.equal(request.instructions, SYSTEM_PROMPT);
        assert.ok(request.instructions.length + 2 + request.input.length <= REVIEW_REQUEST_LIMIT);
        assert.ok(request.input.endsWith('All diff content assigned to this segment is included above.'));
        assert.match(request.input, /Repository: owner\/repo/);
        assert.match(request.input, /do not guess it, resolve a moving branch, or use the repository default/);
      }
    }
    for (diff of [small, large]) {
      sent = [];
      await runPRReview(1, 'owner', 'repo', 1, head);
      verifyCoverage(diff, [configuredPrompt, customPrompt]);
      for (const { input } of sent) {
        assert.ok(input.includes('Server-verified reviewed head SHA: ' + head));
        assert.ok(input.includes('Server-reported base branch tip SHA (not the diff base): ' + base));
        assert.match(input, /repository identity and head checked server-side/);
        assert.match(input, /never use it as the diff base/);
        assert.doesNotMatch(input, /Client-reported head source anchor:/);
      }
      for (const selector of [{ headSha: head, ref: 'ignored-branch' }, { headSha: 'abc123' }, { headSha: 'feature/review' }, { ref: 'main' }, { ref: head }]) {
        sent = []; promptRefs = [];
        const local = await runLocalReview({ repo: 'owner/repo', diff, ...selector, __deps: {
          getUserPrompt: async () => configuredPrompt,
          fetchChecksFromGit: async (repo, ref) => { promptRefs.push([repo, ref]); return [{ name: 'security', prompt: customPrompt }]; },
        }});
        assert.equal(local.executionFailures.length, 0);
        assert.equal(local.checks.length, 2);
        assert.deepEqual(promptRefs, [['owner/repo', selector.headSha || selector.ref]]);
        verifyCoverage(diff, [configuredPrompt, customPrompt]);
        for (const { input } of sent) {
          assert.match(input, /caller-provided local\/working diff/);
          assert.match(input, /client-reported, not server-verified/);
          assert.match(input, /does not prove that the supplied diff or working files equal that commit/);
          assert.match(input, /Base source anchor: unavailable/);
          assert.ok(input.includes('Git-backed review prompt selector (not source verification): ' + (selector.headSha || selector.ref)));
          const expectedAnchor = (selector.headSha || selector.ref) === head ? head : 'unavailable (no full immutable SHA)';
          assert.ok(input.includes('Client-reported head source anchor: ' + expectedAnchor));
          assert.doesNotMatch(input, /Server-verified reviewed head SHA:/);
        }
      }
    }
    // The server still refuses stale-head reviews before any reviewer request.
    sent = []; currentHead = 'c'.repeat(40);
    await runPRReview(1, 'owner', 'repo', 1, head);
    assert.equal(sent.length, 0);
    // Provenance itself is counted, including the local prompt selector.
    sent = [];
    const oversized = await runLocalReview({ repo: 'owner/repo', ref: 'x'.repeat(60000), diff: small, __deps: {
      getUserPrompt: async () => configuredPrompt, fetchChecksFromGit: async () => [],
    }});
    assert.equal(sent.length, 0);
    assert.match(oversized.executionFailures[0].error, /transport budget/);
    console.log('Verified real PR/local outbound HTTP input, both checks, full/segmented reconstruction, source provenance and budget.');
    `,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('missing or malformed immutable source IDs are explicitly unavailable, not guessed', () => {
  for (const source of [undefined, { kind: 'github-pr' as const, headSha: 'main' }, { kind: 'local-diff' as const, promptRef: 'branch', headSha: 'abc123' }]) {
    const [{ context }] = buildReviewContexts({ owner: 'owner', repo: 'repo', diff: '+change', diffLimit: 10000, source });
    assert.match(context, /unavailable/);
    assert.match(context, /INCOMPLETE only if genuinely necessary context remains unavailable/);
    assert.doesNotMatch(context, /(?:head SHA|head source anchor): (?:main|abc123)/);
  }
});
