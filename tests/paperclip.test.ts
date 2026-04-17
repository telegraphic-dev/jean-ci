import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailedChecksComment,
  buildFailedChecksNotificationMarker,
  extractPaperclipIssueIds,
  resolvePaperclipCompanyId,
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

test('extractPaperclipIssueIds parses identifier references and company-prefixed issue URLs', () => {
  const ids = extractPaperclipIssueIds(
    'Paperclip issue: THE-88',
    '<!-- paperclip-issue-id:the-88 -->',
    'https://paperclip.telegraphic.app/THE/issues/the-88',
  );

  assert.deepEqual(ids, ['THE-88']);
});

test('extractPaperclipIssueIds supports mixed UUID and identifier references', () => {
  const issueId = '123e4567-e89b-12d3-a456-426614174000';
  const ids = extractPaperclipIssueIds(
    `Paperclip issue: ${issueId}`,
    'Paperclip issue: the-88',
  );

  assert.deepEqual(ids, [issueId, 'THE-88']);
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

test('buildFailedChecksComment includes owner mention when provided', () => {
  const marker = buildFailedChecksNotificationMarker('owner/repo', 42, 'abc123');
  const comment = buildFailedChecksComment({
    marker,
    prTitle: 'Fix flaky workflow',
    prUrl: 'https://github.com/owner/repo/pull/42',
    ownerMention: '@Founding Engineer',
    failedChecks: [
      {
        name: 'test',
        conclusion: 'failure',
      },
    ],
  });

  assert.ok(comment.includes('@Founding Engineer checks are complete and failures need follow-up.'));
  assert.ok(comment.includes(marker));
});

test('resolvePaperclipCompanyId prefers first valid UUID and ignores invalid values', () => {
  const valid = 'fa801dbc-afa1-4435-b12c-4e15dbc7a3bf';
  assert.equal(resolvePaperclipCompanyId('THE', valid), valid);
  assert.equal(resolvePaperclipCompanyId('invalid', null, undefined), null);
});
