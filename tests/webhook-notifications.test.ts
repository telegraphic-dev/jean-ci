import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueCommentNotification,
  buildPullRequestReviewCommentNotification,
  buildPullRequestReviewNotification,
  isAutomationActor,
  isJeanGitHubActor,
  shouldForwardPullRequestReview,
} from '../lib/review-feedback.ts';
import { handleIssueComment as handleIssueCommentEvent, handlePullRequestReview as handlePullRequestReviewEvent } from '../lib/webhook-handlers.ts';

const originalNotifyFlag = process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED;
const originalGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

test.afterEach(() => {
  process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = originalNotifyFlag;
  process.env.OPENCLAW_GATEWAY_URL = originalGatewayUrl;
  process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
});

test('isAutomationActor detects bot and app-backed actors', () => {
  assert.equal(isAutomationActor({ login: 'copilot-pull-request-reviewer', type: 'Bot' }), true);
  assert.equal(isAutomationActor({ login: 'alice', type: 'User' }, { slug: 'copilot' }), true);
  assert.equal(isAutomationActor({ login: 'alice', type: 'User' }), false);
});

test('isJeanGitHubActor recognizes jean-owned bot accounts', () => {
  assert.equal(isJeanGitHubActor('jean-de-bot'), true);
  assert.equal(isJeanGitHubActor('JEAN-CI[BOT]'), true);
  assert.equal(isJeanGitHubActor('copilot-pull-request-reviewer'), false);
});

test('shouldForwardPullRequestReview forwards blocking human reviews and bot comments', () => {
  assert.equal(shouldForwardPullRequestReview({ state: 'changes_requested', user: { login: 'alice', type: 'User' } }), true);
  assert.equal(shouldForwardPullRequestReview({ state: 'commented', user: { login: 'chatgpt-codex-connector', type: 'Bot' } }), true);
  assert.equal(shouldForwardPullRequestReview({ state: 'commented', user: { login: 'alice', type: 'User' } }), false);
});

test('buildPullRequestReviewNotification includes changes requested review details', () => {
  const notification = buildPullRequestReviewNotification({
    action: 'submitted',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    pull_request: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
    },
    review: {
      state: 'changes_requested',
      body: 'This is still broken.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#pullrequestreview-1',
      user: { login: 'alice', type: 'User' },
    },
  });

  assert.equal(notification?.sessionKey, 'telegram:48102236');
  assert.match(notification?.message || '', /PR Review: Changes Requested/);
  assert.match(notification?.message || '', /This is still broken\./);
});

test('buildPullRequestReviewNotification forwards bot COMMENTED reviews too', () => {
  const notification = buildPullRequestReviewNotification({
    action: 'submitted',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    pull_request: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
    },
    review: {
      state: 'commented',
      body: 'Codex has a suggestion.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#pullrequestreview-2',
      user: { login: 'chatgpt-codex-connector', type: 'Bot' },
    },
  });

  assert.equal(notification?.sessionKey, 'telegram:48102236');
  assert.match(notification?.message || '', /External PR Review/);
  assert.match(notification?.message || '', /chatgpt-codex-connector/);
  assert.match(notification?.message || '', /Codex has a suggestion\./);
});

test('buildPullRequestReviewCommentNotification forwards bot inline review comments', () => {
  const notification = buildPullRequestReviewCommentNotification({
    action: 'created',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    pull_request: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
    },
    comment: {
      body: 'Possible null dereference here.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#discussion_r1',
      path: 'openclaw-mentor/lib/publications.ts',
      user: { login: 'copilot-pull-request-reviewer', type: 'Bot' },
    },
  });

  assert.equal(notification?.sessionKey, 'telegram:48102236');
  assert.match(notification?.message || '', /External PR Review Comment/);
  assert.match(notification?.message || '', /openclaw-mentor\/lib\/publications\.ts/);
  assert.match(notification?.message || '', /Possible null dereference here\./);
});

test('buildIssueCommentNotification forwards PR issue comments from automation bots', () => {
  const notification = buildIssueCommentNotification({
    action: 'created',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    issue: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
      pull_request: { url: 'https://api.github.com/repos/telegraphic-dev/openclaw-mentor/pulls/184' },
    },
    comment: {
      body: 'Automated suggestion summary.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#issuecomment-1',
      user: { login: 'copilot-pull-request-reviewer', type: 'Bot' },
    },
  });

  assert.equal(notification?.sessionKey, 'telegram:48102236');
  assert.match(notification?.message || '', /External PR Comment/);
  assert.match(notification?.message || '', /Automated suggestion summary\./);
});

test('buildIssueCommentNotification forwards app-attributed PR comments even from non-bot users', () => {
  const notification = buildIssueCommentNotification({
    action: 'created',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    issue: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
      pull_request: { url: 'https://api.github.com/repos/telegraphic-dev/openclaw-mentor/pulls/184' },
    },
    comment: {
      body: 'GitHub app suggestion summary.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#issuecomment-2',
      user: { login: 'some-human-login', type: 'User' },
      performed_via_github_app: { slug: 'copilot' },
    },
  });

  assert.equal(notification?.sessionKey, 'telegram:48102236');
  assert.match(notification?.message || '', /External PR Comment/);
  assert.match(notification?.message || '', /some-human-login/);
  assert.match(notification?.message || '', /GitHub app suggestion summary\./);
});

test('buildPullRequestReviewNotification skips jean-ci authored reviews', () => {
  const notification = buildPullRequestReviewNotification({
    action: 'submitted',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    pull_request: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
    },
    review: {
      state: 'changes_requested',
      body: 'Jean feedback',
      user: { login: 'jean-de-bot', type: 'Bot' },
    },
  });

  assert.equal(notification, null);
});

test('handlePullRequestReview sends notifications through the injected session RPC path', async () => {
  process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = 'true';
  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'secret';

  const sent: Array<{ sessionKey: string; message: string }> = [];
  await handlePullRequestReviewEvent({
    action: 'submitted',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    pull_request: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
    },
    review: {
      state: 'commented',
      body: 'Codex has a suggestion.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#pullrequestreview-2',
      user: { login: 'chatgpt-codex-connector', type: 'Bot' },
    },
  }, {
    notifyOpenClawSession: async (sessionKey, message) => {
      sent.push({ sessionKey, message });
    },
  });

  assert.deepEqual(sent.map(({ sessionKey }) => sessionKey), ['telegram:48102236']);
  assert.match(sent[0]?.message || '', /External PR Review/);
  assert.match(sent[0]?.message || '', /Codex has a suggestion\./);
});

test('handleIssueComment sends automation PR comments through the injected session RPC path', async () => {
  process.env.OPENCLAW_NOTIFY_ON_CHANGES_REQUESTED = 'true';
  process.env.OPENCLAW_GATEWAY_URL = 'ws://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'secret';

  const sent: Array<{ sessionKey: string; message: string }> = [];
  await handleIssueCommentEvent({
    action: 'created',
    repository: { full_name: 'telegraphic-dev/openclaw-mentor' },
    issue: {
      number: 184,
      title: 'Add publications',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184',
      body: '<!-- oc-session:telegram:48102236 -->\n\nPR body',
      pull_request: { url: 'https://api.github.com/repos/telegraphic-dev/openclaw-mentor/pulls/184' },
    },
    comment: {
      body: 'GitHub app suggestion summary.',
      html_url: 'https://github.com/telegraphic-dev/openclaw-mentor/pull/184#issuecomment-2',
      user: { login: 'some-human-login', type: 'User' },
      performed_via_github_app: { slug: 'copilot' },
    },
  }, {
    notifyOpenClawSession: async (sessionKey, message) => {
      sent.push({ sessionKey, message });
    },
  });

  assert.deepEqual(sent.map(({ sessionKey }) => sessionKey), ['telegram:48102236']);
  assert.match(sent[0]?.message || '', /External PR Comment/);
  assert.match(sent[0]?.message || '', /GitHub app suggestion summary\./);
});
