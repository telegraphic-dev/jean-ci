const PAPERCLIP_API_URL = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '');
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;
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
    const pieces = trimmed.replace(/^\/+|\/+$/g, '').split('/');
    if (pieces.length !== 2) return null;
    const owner = pieces[0];
    const repo = pieces[1].replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    return `${owner}/${repo}`.toLowerCase();
  }
}

function issueRepoMatches(issue: any, repoFullName: string): boolean {
  const expected = normalizeRepoFullName(repoFullName);
  if (!expected) return false;

  const repoCandidates = new Set<string>();
  const project = issue?.project;

  const primaryRepo = normalizeRepoFullName(project?.primaryWorkspace?.repoUrl);
  if (primaryRepo) repoCandidates.add(primaryRepo);

  const workspaces = Array.isArray(project?.workspaces) ? project.workspaces : [];
  for (const workspace of workspaces) {
    const repo = normalizeRepoFullName(workspace?.repoUrl);
    if (repo) repoCandidates.add(repo);
  }

  if (repoCandidates.size === 0) {
    return false;
  }

  return repoCandidates.has(expected);
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
        `Skipping Paperclip sync for issue ${issueId}: project repo does not match merged PR repo ${repoFullName}`
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
