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

export function extractChangedFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;

  for (const match of diff.matchAll(regex)) {
    const beforePath = match[1]?.trim();
    const afterPath = match[2]?.trim();
    const chosenPath = afterPath && afterPath !== '/dev/null'
      ? afterPath
      : beforePath;

    if (chosenPath && chosenPath !== '/dev/null') {
      paths.add(chosenPath);
    }
  }

  return [...paths];
}

export interface ReviewDiffChunk {
  subsystem: string;
  diff: string;
}

function classifySubsystem(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.startsWith('.github/') || normalized.startsWith('terraform/') || normalized.startsWith('infra/') || /(^|\/)(dockerfile|docker-compose|kubernetes|helm)(\.|\/|$)/.test(normalized)) return 'infrastructure';
  if (normalized.startsWith('docs/') || /(^|\/)(readme|changelog|license)(\.|$)/.test(normalized)) return 'documentation';
  if (/(^|\/)(test|tests|__tests__|spec)(\/|\.|$)/.test(normalized)) return 'tests';
  if (normalized.startsWith('app/') || normalized.startsWith('components/') || normalized.startsWith('pages/') || normalized.startsWith('frontend/')) return 'frontend';
  if (normalized.startsWith('api/') || normalized.startsWith('lib/') || normalized.startsWith('server/') || normalized.startsWith('backend/') || normalized.startsWith('db/')) return 'backend';
  return path.split('/')[0] || 'other';
}

function splitDiffFiles(diff: string): Array<{ path: string; content: string }> {
  const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  return sections.map((content) => ({
    path: extractChangedFilePaths(content)[0] || 'unknown-file',
    content,
  }));
}

/** Keep all files from a subsystem together until the review budget is full. */
export function splitReviewDiffBySubsystem(diff: string, limit: number): ReviewDiffChunk[] {
  if (!diff.trim()) return [{ subsystem: 'empty diff', diff }];
  const safeLimit = Math.max(1, limit);
  const chunks: ReviewDiffChunk[] = [];
  const currentBySubsystem = new Map<string, string>();

  const flush = (subsystem: string) => {
    const content = currentBySubsystem.get(subsystem);
    if (content) chunks.push({ subsystem, diff: content });
    currentBySubsystem.delete(subsystem);
  };

  for (const file of splitDiffFiles(diff)) {
    const subsystem = classifySubsystem(file.path);
    const current = currentBySubsystem.get(subsystem) || '';
    if (current && current.length + file.content.length + 1 > safeLimit) {
      flush(subsystem);
    }
    currentBySubsystem.set(subsystem, `${currentBySubsystem.get(subsystem) ? `${currentBySubsystem.get(subsystem)}\n` : ''}${file.content}`);
  }
  for (const subsystem of [...currentBySubsystem.keys()]) flush(subsystem);
  return chunks;
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
  const changedPaths = extractChangedFilePaths(input.diff);
  const repoNamePrefixedPaths = input.repo
    ? changedPaths.filter((path) => path === input.repo || path.startsWith(`${input.repo}/`))
    : [];

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
          '- Treat diff file paths literally, relative to the repo root. Do not strip, rewrite, or guess away leading directories from changed paths.',
          ...(repoNamePrefixedPaths.length > 0
            ? [
                `- Some changed files already begin with the repo-name directory prefix \`${input.repo}/...\`. Keep that prefix when reading files locally, for example \`${canonicalRepoPath}/${repoNamePrefixedPaths[0]}\`.`
              ]
            : []),
          '- The diff below is the source of truth for PR changes. The local checkout is only for surrounding context and may not include the PR head commit yet.',
          '- If a diff file is missing locally, review the diff instead of failing on the missing path.',
        ]
      : []),
    ...(changedPaths.length > 0
      ? [
          '',
          '## Changed Files',
          ...changedPaths.slice(0, 200).map((path) => `- ${path}`),
          ...(changedPaths.length > 200 ? [`- ... (${changedPaths.length - 200} more files omitted)`] : []),
        ]
      : []),
    '',
    '## Diff',
    '```diff',
    truncateReviewDiff(input.diff, input.diffLimit),
    '```',
  ].join('\n');
}

export function buildReviewContexts(input: Parameters<typeof buildReviewContext>[0]): Array<{ label: string; context: string }> {
  const chunks = splitReviewDiffBySubsystem(input.diff, input.diffLimit);
  return chunks.map((chunk, index) => {
    const label = `${chunk.subsystem} (${index + 1}/${chunks.length})`;
    const context = buildReviewContext({ ...input, diff: chunk.diff });
    return {
      label,
      context: `${context}\n\n## Review Scope\nThis is subsystem segment ${label}. Review this segment rigorously; do not assume unshown subsystems are safe.`,
    };
  });
}
