import { REVIEW_REQUEST_LIMIT, reviewRequestLength, assertReviewRequestFits } from './review-request.ts';

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
  paths?: string[];
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

function splitOversizedDiffFile(content: string, limit: number): string[] {
  if (content.length <= limit) return [content];

  const pieces: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(content.length, offset + limit);
    if (end < content.length) {
      // Prefer complete hunks, then lines. A single huge line must be split.
      const window = content.slice(offset, end);
      const hunk = window.lastIndexOf('\n@@ ');
      const line = window.lastIndexOf('\n');
      if (hunk > limit / 2) end = offset + hunk + 1;
      else if (line >= 0) end = offset + line + 1;
      // Do not split a UTF-16 surrogate pair across requests.
      else if (end > offset + 1 && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    }
    pieces.push(content.slice(offset, end));
    offset = end;
  }
  return pieces;
}

/** Keep all files from a subsystem together until the review budget is full. */
export function splitReviewDiffBySubsystem(diff: string, limit: number): ReviewDiffChunk[] {
  if (!diff.length) return [{ subsystem: 'empty diff', diff }];
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Review diff limit must be an integer of at least 2 chars.');
  const safeLimit = limit;
  const chunks: ReviewDiffChunk[] = [];
  const currentBySubsystem = new Map<string, string>();
  const pathsBySubsystem = new Map<string, Set<string>>();

  const flush = (subsystem: string) => {
    const content = currentBySubsystem.get(subsystem);
    if (content) chunks.push({ subsystem, diff: content, paths: [...(pathsBySubsystem.get(subsystem) || [])] });
    currentBySubsystem.delete(subsystem);
    pathsBySubsystem.delete(subsystem);
  };

  for (const file of splitDiffFiles(diff)) {
    const subsystem = classifySubsystem(file.path);
    for (const segment of splitOversizedDiffFile(file.content, safeLimit)) {
      const current = currentBySubsystem.get(subsystem) || '';
      if (current && current.length + segment.length > safeLimit) {
        flush(subsystem);
      }
      currentBySubsystem.set(subsystem, `${currentBySubsystem.get(subsystem) || ''}${segment}`);
      if (!pathsBySubsystem.has(subsystem)) pathsBySubsystem.set(subsystem, new Set());
      pathsBySubsystem.get(subsystem)!.add(file.path);
    }
  }
  for (const subsystem of [...currentBySubsystem.keys()]) flush(subsystem);
  return chunks;
}

export type ReviewSource =
  | { kind: 'github-pr'; headSha: string; baseSha?: string }
  | { kind: 'local-diff'; promptRef: string; headSha?: string | null };

function immutableSha(value?: string | null): string | null {
  return value && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value) ? value : null;
}

function sourceProvenance(source?: ReviewSource): string[] {
  if (source?.kind === 'github-pr') {
    return [
      '- Source: GitHub PR diff; repository identity and head checked server-side against GitHub PR metadata.',
      `- Server-verified reviewed head SHA: ${immutableSha(source.headSha) || 'unavailable (no full immutable SHA)'}`,
      `- Server-reported base branch tip SHA (not the diff base): ${immutableSha(source.baseSha) || 'unavailable (no full immutable SHA)'}`,
      '- The base branch tip may have advanced since divergence. It is not a verified merge base or pre-change source anchor: never use it as the diff base. The actual diff base is unavailable unless independently established.',
      '- Use the verified head for surrounding committed source; the supplied diff defines the changes under review.',
    ];
  }
  if (source?.kind === 'local-diff') {
    return [
      '- Source: caller-provided local/working diff, possibly including uncommitted changes. Repository identity and source anchors are client-reported, not server-verified.',
      `- Git-backed review prompt selector (not source verification): ${source.promptRef}`,
      `- Client-reported head source anchor: ${immutableSha(source.headSha) || 'unavailable (no full immutable SHA)'}`,
      '- Base source anchor: unavailable; this API does not receive a base SHA.',
      '- A head source anchor identifies committed surrounding context only. It does not prove that the supplied diff or working files equal that commit; never substitute committed content for uncommitted changes.',
    ];
  }
  return ['- Source provenance: unavailable; no server-verified reviewed commit or client-reported immutable source anchor was supplied.'];
}

export function buildReviewContext(
  input: {
    title?: string | null;
    body?: string | null;
    diff: string;
    diffLimit: number;
    userPrompt?: string;
    changedPaths?: string[];
    owner?: string;
    repo?: string;
    source?: ReviewSource;
  },
): string {
  if (input.diff.length > input.diffLimit) throw new Error('Diff exceeds single-context limit; use buildReviewContexts for complete coverage.');
  const canonicalRepoPath = input.owner && input.repo
    ? buildCanonicalRepoPath(input.owner, input.repo)
    : null;
  const changedPaths = input.changedPaths || extractChangedFilePaths(input.diff);
  const repoNamePrefixedPaths = input.repo
    ? changedPaths.filter((path) => path === input.repo || path.startsWith(`${input.repo}/`))
    : [];

  return [
    `# Pull Request: ${input.title?.trim() || 'Local review'}`,
    '',
    '## Source Provenance',
    ...sourceProvenance(input.source),
    '- If an immutable source ID is missing or unverified, do not guess it, resolve a moving branch, or use the repository default as reviewed source. Review the supplied diff first; use VERDICT: INCOMPLETE only if genuinely necessary context remains unavailable.',
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
          '- The supplied diff is the source of truth for changes under review. The local checkout is only a location hint, not verified source; it may differ from both the source anchor and uncommitted changes.',
          '- If a diff file is missing locally, review the diff instead of failing on the missing path.',
        ]
      : []),
    ...(changedPaths.length > 0
      ? [
          '',
          '## Changed Files',
          ...changedPaths.map((path) => `- ${path}`),
        ]
      : []),
    '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
  ].join('\n');
}

const SCOPE_RULES = 'Intentional segment boundaries: other segments are reviewed separately. Do not treat unshown segments or a continued file/hunk as missing code, and do not assume them safe. Review the supplied segment against the criteria. If cross-segment evidence is genuinely necessary and cannot be obtained with approved tools, report VERDICT: INCOMPLETE with the required evidence, not a speculative code finding.';
const REVIEW_FOOTER = '\n\n## End of Review Input\nAll diff content assigned to this segment is included above.';

export function buildReviewContexts(input: Parameters<typeof buildReviewContext>[0]): Array<{ label: string; context: string }> {
  if (!Number.isSafeInteger(input.diffLimit) || input.diffLimit < 2) throw new Error('Review diff limit must be an integer of at least 2 chars.');
  const prompt = input.userPrompt || '';
  const render = (diff: string, paths: string[], label: string) =>
    `## Review Scope\nThis is subsystem segment ${label}. ${SCOPE_RULES}\n\n${buildReviewContext({ ...input, diff, changedPaths: paths, diffLimit: Math.max(input.diffLimit, diff.length) })}${REVIEW_FOOTER}`;
  const paths = extractChangedFilePaths(input.diff);
  const full = render(input.diff, paths, 'full diff (1/1)');
  if (input.diff.length <= input.diffLimit && reviewRequestLength(prompt, full) <= REVIEW_REQUEST_LIMIT) {
    return [{ label: 'full diff (1/1)', context: full }];
  }
  // Reserve all metadata, the full file list, scope, footer and exact system/user
  // assembly. This upper bound covers every segment's label and path guidance.
  const subsystems = splitDiffFiles(input.diff).map(({ path }) => classifySubsystem(path));
  const longestSubsystem = subsystems.sort((a, b) => b.length - a.length)[0] || 'empty diff';
  const largestLabel = `${longestSubsystem} (${input.diff.length}/${input.diff.length})`;
  const overhead = render('', [...paths].sort((a, b) => b.length - a.length), largestLabel);
  assertReviewRequestFits(prompt, overhead);
  const budget = Math.min(input.diffLimit, REVIEW_REQUEST_LIMIT - reviewRequestLength(prompt, overhead));
  if (budget < 2) throw new Error('Review metadata/criteria leave no diff transport budget; nothing was sent.');
  const chunks = splitReviewDiffBySubsystem(input.diff, budget);
  return chunks.map((chunk, index) => {
    const label = `${chunk.subsystem} (${index + 1}/${chunks.length})`;
    const context = render(chunk.diff, chunk.paths || paths, label);
    assertReviewRequestFits(prompt, context);
    return { label, context };
  });
}
