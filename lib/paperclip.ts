const PAPERCLIP_API_URL = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '');
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAPERCLIP_URL_ISSUE_RE = /https?:\/\/[^\s]*paperclip[^\s]*\/issues\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/ig;
const PAPERCLIP_MARKER_RE = /paperclip(?:[-_ ]issue(?:[-_ ]id)?)?\s*[:#]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/ig;
const PAPERCLIP_HTML_COMMENT_RE = /<!--\s*paperclip-issue-id\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/ig;

function collectMatches(regex: RegExp, input: string): string[] {
  return Array.from(input.matchAll(regex), match => match[1]?.toLowerCase()).filter(Boolean) as string[];
}

export function extractPaperclipIssueIds(...inputs: Array<string | null | undefined>): string[] {
  const values = inputs.filter(Boolean).join('\n');
  if (!values) return [];

  const ids = new Set<string>([
    ...collectMatches(PAPERCLIP_URL_ISSUE_RE, values),
    ...collectMatches(PAPERCLIP_MARKER_RE, values),
    ...collectMatches(PAPERCLIP_HTML_COMMENT_RE, values),
  ]);

  if (ids.size > 0) {
    return [...ids];
  }

  const lower = values.toLowerCase();
  if (!lower.includes('paperclip')) {
    return [];
  }

  for (const match of values.match(UUID_RE) || []) {
    ids.add(match.toLowerCase());
  }
  return [...ids];
}

export function isPaperclipConfigured(): boolean {
  return Boolean(PAPERCLIP_API_URL && PAPERCLIP_API_KEY);
}

function normalizeUuid(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return UUID_EXACT_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolvePaperclipCompanyId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeUuid(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeRepoFullName(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!/github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    const parts = trimmed.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    return `${owner}/${repo}`.toLowerCase();
  }
}

function issueRepoMatches(issue: any, repoFullName: string): boolean {
  const expected = normalizeRepoFullName(repoFullName);
  if (!expected) return false;

  const candidates = new Set<string>();
  const primary = normalizeRepoFullName(issue?.project?.primaryWorkspace?.repoUrl);
  if (primary) candidates.add(primary);

  const workspaces = Array.isArray(issue?.project?.workspaces) ? issue.project.workspaces : [];
  for (const workspace of workspaces) {
    const candidate = normalizeRepoFullName(workspace?.repoUrl);
    if (candidate) candidates.add(candidate);
  }

  if (candidates.size === 0) return false;
  return candidates.has(expected);
}

async function paperclipFetch(path: string, init?: RequestInit) {
  if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY) {
    throw new Error('Paperclip is not configured');
  }

  const response = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${PAPERCLIP_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Paperclip API ${response.status}: ${errorText}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function markLinkedPaperclipIssuesDone(params: {
  prUrl: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  issueIds: string[];
}) {
  const { prUrl, repoFullName, prNumber, prTitle, issueIds } = params;

  for (const issueId of issueIds) {
    const issue = await paperclipFetch(`/api/issues/${issueId}`);
    if (!issueRepoMatches(issue, repoFullName)) {
      console.warn(
        `Skipping Paperclip done-sync for issue ${issueId}: project repo does not match ${repoFullName}`
      );
      continue;
    }

    await paperclipFetch(`/api/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'done',
        comment: `Marked done automatically after GitHub PR merged: ${repoFullName}#${prNumber} — ${prTitle} (${prUrl})`,
      }),
    });
  }
}

export interface FailedCheckSummary {
  name: string;
  conclusion: string;
  checkRunUrl?: string | null;
  workflowUrl?: string | null;
  jeanCheckUrl?: string | null;
}

export function buildFailedChecksNotificationMarker(repoFullName: string, prNumber: number, headSha: string): string {
  return `<!-- jean-ci:paperclip-failing-checks repo=${repoFullName} pr=${prNumber} sha=${headSha} -->`;
}

export function buildFailedChecksComment(params: {
  marker: string;
  prTitle: string;
  prUrl: string;
  failedChecks: FailedCheckSummary[];
  ownerMention?: string | null;
}): string {
  const ownerLine = params.ownerMention
    ? `${params.ownerMention} checks are complete and failures need follow-up.`
    : null;
  const lines: string[] = [
    '## PR checks failed',
    '',
    `Checks finished with failures for [${params.prTitle}](${params.prUrl}).`,
    ...(ownerLine ? ['', ownerLine] : []),
    '',
    `- Failed checks: ${params.failedChecks.length}`,
    ...params.failedChecks.map((check) => {
      const links: string[] = [];
      if (check.checkRunUrl) links.push(`[check run](${check.checkRunUrl})`);
      if (check.workflowUrl && check.workflowUrl !== check.checkRunUrl) links.push(`[workflow/job](${check.workflowUrl})`);
      if (check.jeanCheckUrl) links.push(`[jean-ci](${check.jeanCheckUrl})`);

      const parts = [`\`${check.name}\` (${check.conclusion})`];
      if (links.length > 0) {
        parts.push(links.join(' | '));
      }
      return `- ${parts.join(' - ')}`;
    }),
    '',
    params.marker,
  ];

  return lines.join('\n');
}

function readCommentText(comment: any): string {
  return (
    comment?.body ||
    comment?.content ||
    comment?.markdown ||
    comment?.text ||
    ''
  );
}

let cachedAgentMentions: Map<string, string> | null = null;
let cachedCompanyId: string | null | undefined = undefined;

async function getPaperclipCompanyId(issue?: any): Promise<string | null> {
  if (cachedCompanyId !== undefined) {
    return cachedCompanyId;
  }

  const configuredCompanyId = resolvePaperclipCompanyId(PAPERCLIP_COMPANY_ID);
  if (configuredCompanyId) {
    cachedCompanyId = configuredCompanyId;
    return cachedCompanyId;
  }

  try {
    const me = await paperclipFetch('/api/agents/me');
    const meCompanyId = resolvePaperclipCompanyId(me?.companyId);
    if (meCompanyId) {
      cachedCompanyId = meCompanyId;
      return cachedCompanyId;
    }
  } catch (error: any) {
    console.warn(`Failed to resolve Paperclip company id from /api/agents/me: ${error?.message || error}`);
  }

  const issueCompanyId = resolvePaperclipCompanyId(issue?.companyId, issue?.project?.companyId);
  cachedCompanyId = issueCompanyId;
  return cachedCompanyId;
}

async function getAgentMentionsById(issue?: any): Promise<Map<string, string>> {
  if (cachedAgentMentions) {
    return cachedAgentMentions;
  }

  const companyId = await getPaperclipCompanyId(issue);
  if (!companyId) {
    cachedAgentMentions = new Map();
    return cachedAgentMentions;
  }

  const agents = await paperclipFetch(`/api/companies/${companyId}/agents`);
  const mentions = new Map<string, string>();
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      if (!agent?.id) continue;

      const humanName = typeof agent?.name === 'string' && agent.name.trim().length > 0
        ? agent.name.trim()
        : null;

      if (humanName) {
        mentions.set(agent.id, `@${humanName}`);
        continue;
      }

      if (agent?.urlKey) {
        mentions.set(agent.id, `@${agent.urlKey}`);
      }
    }
  }

  cachedAgentMentions = mentions;
  return mentions;
}

async function resolveIssueOwnerMention(issue: any): Promise<string | null> {
  const assigneeAgentId = issue?.assigneeAgentId;
  if (!assigneeAgentId) return null;

  try {
    const mentionsById = await getAgentMentionsById(issue);
    return mentionsById.get(assigneeAgentId) || null;
  } catch (error: any) {
    console.warn(`Failed to resolve Paperclip assignee mention for ${assigneeAgentId}: ${error?.message || error}`);
    return null;
  }
}

export async function commentLinkedPaperclipIssuesOnFailedChecks(params: {
  issueIds: string[];
  repoFullName: string;
  prNumber: number;
  headSha: string;
  prTitle: string;
  prUrl: string;
  failedChecks: FailedCheckSummary[];
}) {
  const { issueIds, repoFullName, prNumber, headSha, prTitle, prUrl, failedChecks } = params;
  const marker = buildFailedChecksNotificationMarker(repoFullName, prNumber, headSha);

  for (const issueId of issueIds) {
    const issue = await paperclipFetch(`/api/issues/${issueId}`);
    if (!issueRepoMatches(issue, repoFullName)) {
      console.warn(
        `Skipping Paperclip failing-check comment for issue ${issueId}: project repo does not match ${repoFullName}`
      );
      continue;
    }

    const comments = await paperclipFetch(`/api/issues/${issueId}/comments`);
    const alreadyPosted = Array.isArray(comments)
      ? comments.some((entry) => readCommentText(entry).includes(marker))
      : false;

    if (alreadyPosted) {
      continue;
    }

    const ownerMention = await resolveIssueOwnerMention(issue);
    const comment = buildFailedChecksComment({
      marker,
      prTitle,
      prUrl,
      failedChecks,
      ownerMention,
    });

    await paperclipFetch(`/api/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        comment,
      }),
    });
  }
}
