import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptValidationSummary } from '../lib/review-output.ts';
import { runLocalReview } from '../lib/local-review.ts';

const callOpenClawCalls: Array<{ prompt: string; context: string; metadata: any }> = [];

await test('runLocalReview executes Code Review and git-backed custom checks through jean-ci review flow', async () => {
  const result = await runLocalReview({
    repo: 'telegraphic-dev/jean-ci',
    title: 'Local diff review',
    body: 'Review working tree changes',
    diff: 'diff --git a/file.ts b/file.ts\n+const value = true;\n',
    headSha: 'abc123',
    __deps: {
      getUserPrompt: async () => '## Review Criteria\n\nKeep it tight.',
      fetchChecksFromGit: async () => ([
        {
          name: 'api-openapi-parity',
          prompt: `# API/OpenAPI Parity Check\n\n## Purpose\nKeep API and OpenAPI aligned.\n\n## Review Instructions\nCheck parity.\n\n## Verdict Criteria\nPASS if aligned. FAIL otherwise.`,
        },
      ]),
      callReviewer: async (prompt: string, context: string, metadata: any) => {
        callOpenClawCalls.push({ prompt, context, metadata });
        if (prompt.includes('Parity')) {
          return {
            success: true,
            response: 'VERDICT: FAIL\n\n- app/api/public/v1/local-review/route.ts adds POST behavior\n- lib/public-openapi.ts documents the new endpoint',
          } as const;
        }

        return {
          success: true,
          response: 'VERDICT: PASS\n\n- No blocking issues found',
        } as const;
      },
    },
  } as any);

  assert.equal(result.repo, 'telegraphic-dev/jean-ci');
  assert.equal(result.validationFailures.length, 0);
  assert.equal(result.executionFailures.length, 0);
  assert.equal(result.checks.length, 2);
  assert.deepEqual(result.checks.map((check) => [check.name, check.verdict]), [
    ['Code Review', 'PASS'],
    ['api-openapi-parity', 'FAIL'],
  ]);
  assert.equal(callOpenClawCalls.length, 2);
  assert.match(callOpenClawCalls[0]?.context || '', /# Pull Request: Local diff review/);
  assert.equal(callOpenClawCalls[0]?.metadata.headSha, 'abc123');
  assert.equal(callOpenClawCalls[1]?.metadata.promptName, 'api-openapi-parity');
  callOpenClawCalls.length = 0;
});

await test('runLocalReview reports invalid git-backed prompt files without calling reviewer', async () => {
  const result = await runLocalReview({
    repo: 'telegraphic-dev/jean-ci',
    diff: 'diff --git a/file.ts b/file.ts\n+const value = true;\n',
    headSha: 'abc123',
    selectedChecks: ['broken-check'],
    __deps: {
      getUserPrompt: async () => '## Review Criteria\n\nKeep it tight.',
      fetchChecksFromGit: async () => [{ name: 'broken-check', prompt: 'too short' }],
      callReviewer: async () => {
        throw new Error('callReviewer should not be called for invalid custom checks');
      },
    },
  } as any);

  assert.equal(result.checks.length, 0);
  assert.equal(result.executionFailures.length, 0);
  assert.deepEqual(result.validationFailures, [
    {
      name: 'broken-check',
      isGlobal: false,
      summary: buildPromptValidationSummary([
        'Prompt is too short to be reliable. Add explicit review instructions and verdict criteria.',
        'Missing required section: Purpose.',
        'Missing required section: Review Instructions.',
        'Missing required section: Verdict Criteria.',
        'Verdict Criteria must describe both PASS and FAIL conditions.',
      ]),
    },
  ]);
});

await test('runLocalReview rejects invalid repo slugs and requires git ref', async () => {
  await assert.rejects(
    () => runLocalReview({ repo: 'not-a-valid-repo', diff: 'diff --git a/x b/x\n+1\n' } as any),
    /owner\/repo/
  );

  await assert.rejects(
    () => runLocalReview({ repo: 'telegraphic-dev/jean-ci', diff: 'diff --git a/x b/x\n+1\n' } as any),
    /headSha or ref is required/
  );
});
