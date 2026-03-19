import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailedChecksComment,
  buildFailedChecksNotificationMarker,
  extractPaperclipIssueIds,
} from '../lib/paperclip.ts';

test('extractPaperclipIssueIds parses supported marker formats', () => {
  const issueId = '123e4567-e89b-12d3-a456-426614174000';
  const ids = extractPaperclipIssueIds(
    `Paperclip issue: ${issueId}`,
    `<!-- paperclip-issue-id:${issueId} -->`,
    `https://paperclip.telegraphic.app/issues/${issueId}`,
  );

  assert.deepEqual(ids, [issueId]);
});

test('buildFailedChecksNotificationMarker is deterministic', () => {
  const marker = buildFailedChecksNotificationMarker('owner/repo', 42, 'abc123');
  assert.equal(
    marker,
    '<!-- jean-ci:paperclip-failing-checks repo=owner/repo pr=42 sha=abc123 -->'
  );
});

test('buildFailedChecksComment includes failed checks and links', () => {
  const marker = buildFailedChecksNotificationMarker('owner/repo', 42, 'abc123');
  const comment = buildFailedChecksComment({
    marker,
    prTitle: 'Fix flaky workflow',
    prUrl: 'https://github.com/owner/repo/pull/42',
    failedChecks: [
      {
        name: 'test',
        conclusion: 'failure',
        checkRunUrl: 'https://github.com/owner/repo/runs/1',
        workflowUrl: 'https://github.com/owner/repo/actions/runs/2',
        jeanCheckUrl: 'https://jean-ci.example.com/checks/9',
      },
    ],
  });

  assert.ok(comment.includes('## PR checks failed'));
  assert.ok(comment.includes('Checks finished with failures for [Fix flaky workflow]'));
  assert.ok(comment.includes('`test` (failure)'));
  assert.ok(comment.includes('[check run](https://github.com/owner/repo/runs/1)'));
  assert.ok(comment.includes('[workflow/job](https://github.com/owner/repo/actions/runs/2)'));
  assert.ok(comment.includes('[jean-ci](https://jean-ci.example.com/checks/9)'));
  assert.ok(comment.includes(marker));
});
