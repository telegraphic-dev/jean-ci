export function truncateReviewDiff(diff: string, limit: number): string {
  if (diff.length <= limit) {
    return diff;
  }

  const truncated = diff.substring(0, limit);
  const remaining = diff.length - limit;
  const remainingKB = Math.round(remaining / 1024);
  const lastFileStart = truncated.lastIndexOf('\ndiff --git');
  const cutPoint = lastFileStart > limit * 0.8 ? lastFileStart : limit;

  return truncated.substring(0, cutPoint) +
    `\n\n... [truncated: ${remainingKB}KB remaining, ${diff.split('\ndiff --git').length - truncated.substring(0, cutPoint).split('\ndiff --git').length} files not shown]`;
}

export function buildCanonicalRepoPath(owner: string, repo: string): string {
  return `/home/openclaw/.openclaw/workspace/development/projects/${owner}/${repo}`;
}

export function buildReviewContext(
  input: {
    title?: string | null;
    body?: string | null;
    diff: string;
    diffLimit: number;
    owner?: string;
    repo?: string;
  },
): string {
  const canonicalRepoPath = input.owner && input.repo
    ? buildCanonicalRepoPath(input.owner, input.repo)
    : null;

  return [
    `# Pull Request: ${input.title?.trim() || 'Local review'}`,
    '',
    '## Description',
    input.body?.trim() || 'No description provided',
    ...(input.owner && input.repo && canonicalRepoPath
      ? [
          '',
          '## Repository Context',
          `- Repository: ${input.owner}/${input.repo}`,
          `- Canonical local checkout path: ${canonicalRepoPath}`,
          '- If you inspect repository files with read/exec, use that exact absolute path and do not assume the repo lives at the workspace root.',
          '- The diff below is the source of truth for PR changes. The local checkout is only for surrounding context and may not include the PR head commit yet.',
          '- If a diff file is missing locally, review the diff instead of failing on the missing path.',
        ]
      : []),
    '',
    '## Diff',
    '```diff',
    truncateReviewDiff(input.diff, input.diffLimit),
    '```',
  ].join('\n');
}
