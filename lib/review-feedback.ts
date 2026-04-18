const SESSION_REGEX = /<!--\s*oc-session:([^\s]+)\s*-->/;
const JEAN_GITHUB_LOGINS = new Set(['jean-de-bot', 'jean-ci[bot]']);

export function extractSessionKey(prBody: string | null | undefined): string | null {
  const match = String(prBody || '').match(SESSION_REGEX);
  return match?.[1] || null;
}

export function isJeanGitHubActor(login: string | null | undefined): boolean {
  return JEAN_GITHUB_LOGINS.has(String(login || '').toLowerCase());
}

export function isAutomationActor(user: any, performedViaApp?: any): boolean {
  if (performedViaApp?.slug || performedViaApp?.name || performedViaApp?.id) {
    return true;
  }

  const type = String(user?.type || '').toLowerCase();
  if (type === 'bot') {
    return true;
  }

  const login = String(user?.login || '').toLowerCase();
  return login.endsWith('[bot]');
}

export function shouldForwardPullRequestReview(review: any): boolean {
  const state = String(review?.state || '').toLowerCase();
  if (state === 'changes_requested') {
    return true;
  }

  return isAutomationActor(review?.user, review?.performed_via_github_app);
}

export function buildReviewFeedbackMessage(input: {
  repoFullName: string;
  prNumber: number;
  prTitle?: string | null;
  prUrl?: string | null;
  actorLogin?: string | null;
  eventLabel: string;
  stateLabel?: string | null;
  body?: string | null;
  detailUrl?: string | null;
  filePath?: string | null;
}): string {
  const lines = [
    `🔔 **${input.eventLabel}**`,
    '',
    `**PR:** ${input.repoFullName}#${input.prNumber}${input.prTitle ? ` - ${input.prTitle}` : ''}`,
    `**From:** ${input.actorLogin || 'unknown'}`,
  ];

  if (input.stateLabel) {
    lines.push(`**State:** ${input.stateLabel}`);
  }

  if (input.filePath) {
    lines.push(`**File:** ${input.filePath}`);
  }

  if (input.prUrl) {
    lines.push(`**PR URL:** ${input.prUrl}`);
  }

  if (input.detailUrl && input.detailUrl !== input.prUrl) {
    lines.push(`**Detail URL:** ${input.detailUrl}`);
  }

  lines.push('', '**Feedback:**', input.body?.trim() || 'No specific feedback provided.');
  return lines.join('\n');
}

export function buildPullRequestReviewNotification(payload: any): { sessionKey: string; message: string } | null {
  const { action, review, pull_request, repository } = payload;

  if (action !== 'submitted' || !shouldForwardPullRequestReview(review)) {
    return null;
  }

  const actorLogin = review?.user?.login;
  if (isJeanGitHubActor(actorLogin)) {
    return null;
  }

  const sessionKey = extractSessionKey(pull_request?.body);
  if (!sessionKey) {
    return null;
  }

  const stateLabel = String(review?.state || '').replace(/_/g, ' ');
  const eventLabel = String(review?.state || '').toLowerCase() === 'changes_requested'
    ? 'PR Review: Changes Requested'
    : 'External PR Review';

  return {
    sessionKey,
    message: buildReviewFeedbackMessage({
      repoFullName: repository.full_name,
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      prUrl: pull_request.html_url,
      actorLogin,
      eventLabel,
      stateLabel,
      body: review?.body,
      detailUrl: review?.html_url,
    }),
  };
}

export function buildPullRequestReviewCommentNotification(payload: any): { sessionKey: string; message: string } | null {
  const { action, comment, pull_request, repository } = payload;

  if (action !== 'created') {
    return null;
  }

  const actorLogin = comment?.user?.login;
  if (isJeanGitHubActor(actorLogin) || !isAutomationActor(comment?.user, comment?.performed_via_github_app || payload?.performed_via_github_app)) {
    return null;
  }

  const sessionKey = extractSessionKey(pull_request?.body);
  if (!sessionKey) {
    return null;
  }

  return {
    sessionKey,
    message: buildReviewFeedbackMessage({
      repoFullName: repository.full_name,
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      prUrl: pull_request.html_url,
      actorLogin,
      eventLabel: 'External PR Review Comment',
      body: comment?.body,
      detailUrl: comment?.html_url,
      filePath: comment?.path,
    }),
  };
}

export function buildIssueCommentNotification(payload: any): { sessionKey: string; message: string } | null {
  const { action, issue, comment, repository } = payload;

  if (action !== 'created' || !issue?.pull_request) {
    return null;
  }

  const actorLogin = comment?.user?.login || payload?.sender?.login;
  if (isJeanGitHubActor(actorLogin) || !isAutomationActor(comment?.user, payload?.performed_via_github_app)) {
    return null;
  }

  const sessionKey = extractSessionKey(issue?.body);
  if (!sessionKey) {
    return null;
  }

  return {
    sessionKey,
    message: buildReviewFeedbackMessage({
      repoFullName: repository.full_name,
      prNumber: issue.number,
      prTitle: issue.title,
      prUrl: issue.html_url,
      actorLogin,
      eventLabel: 'External PR Comment',
      body: comment?.body,
      detailUrl: comment?.html_url,
    }),
  };
}
