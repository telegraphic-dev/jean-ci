export type ReviewVerdict = 'PASS' | 'FAIL';

export interface PromptValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ParsedReviewResponse {
  verdict: ReviewVerdict;
  title: string;
  summary: string;
  normalized: string;
  /** Human-facing Markdown, without transport verdict/profile/chunk metadata. */
  reviewMarkdown: string;
}

const REQUIRED_PROMPT_SECTIONS = [
  { label: 'Purpose', patterns: [/^#\s+.+/m, /^##\s+Purpose\b/m] },
  { label: 'Review Instructions', patterns: [/^##\s+Review Instructions\b/m] },
  { label: 'Verdict Criteria', patterns: [/^##\s+Verdict Criteria\b/m] },
];

export function validateReviewPrompt(prompt: string): PromptValidationResult {
  const errors: string[] = [];
  const trimmed = prompt.trim();

  if (!trimmed) {
    return {
      valid: false,
      errors: ['Prompt file is empty. Add review instructions before enabling this check.'],
    };
  }

  if (trimmed.length < 80) {
    errors.push('Prompt is too short to be reliable. Add explicit review instructions and verdict criteria.');
  }

  for (const section of REQUIRED_PROMPT_SECTIONS) {
    const matches = section.patterns.some((pattern) => pattern.test(trimmed));
    if (!matches) {
      errors.push(`Missing required section: ${section.label}.`);
    }
  }

  if (!/PASS/i.test(trimmed) || !/FAIL/i.test(trimmed)) {
    errors.push('Verdict Criteria must describe both PASS and FAIL conditions.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function buildPromptValidationSummary(errors: string[]): string {
  return [
    'This review prompt is invalid and was not sent to the LLM.',
    '',
    'Fix the prompt file and push again:',
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
}

// Only remove recognized metadata, never prose that happens to mention a profile.
// Fences and their contents are opaque, so examples keep their exact Markdown.
function withoutProfileMetadata(markdown: string): string {
  return mapOutsideFences(markdown, (line) => {
    const content = line.trim().replace(/^(?:[-*+]\s+|#{1,6}\s+)/, '').replace(/[*_`]/g, '').trim();
    const profile = content.replace(/^review profile\s*:\s*/i, '');
    if (/^review profile\s*:\s*$/i.test(content)
      || /^(?:(?:diff\s*=\s*(?:reviewed|not reviewed)|repository\s*=\s*(?:not needed|inspected|blocked)|tests\s*=\s*(?:not needed|passed|failed|blocked))(?:;\s*|\.?$))+$/i.test(profile)) return null;
    return line;
  }).replace(/^\n+|\n+$/g, '');
}

function mapOutsideFences(markdown: string, transform: (line: string) => string | null): string {
  let fence: { char: string; length: number } | undefined;
  const output: string[] = [];
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      output.push(line);
    } else {
      const transformed = transform(line);
      if (transformed !== null) output.push(transformed);
    }
  }
  return output.join('\n');
}

export function parseReviewResponse(response: string): ParsedReviewResponse {
  // Trim outer blank lines, not indentation within the review.
  const trimmed = response.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd();
  const lines = trimmed.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const verdictMatch = (lines[firstIndex] || '').trim().match(/^\**VERDICT:\s*(PASS|FAIL|INCOMPLETE)\b\**(.*)$/i);
  if (!verdictMatch) {
    throw new Error('Reviewer response must start with "VERDICT: PASS" or "VERDICT: FAIL" on the first non-empty line.');
  }
  if (verdictMatch[1].toUpperCase() === 'INCOMPLETE') {
    throw new Error(`Reviewer reported VERDICT: INCOMPLETE; review execution did not finish. ${trimmed}`);
  }
  const verdict = verdictMatch[1].toUpperCase() as ReviewVerdict;
  const inlineExplanation = verdictMatch[2].replace(/^\s*[-–—:]\s*/, '').trim();
  const details = [inlineExplanation, ...lines.slice(firstIndex + 1)].join('\n').replace(/^\n+|\n+$/g, '');
  const reviewMarkdown = withoutProfileMetadata(details);
  const hasExplanation = details.split('\n').some((line) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) return false;
    const content = withoutProfileMetadata(line).replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/, '').replace(/[*_`]/g, '').trim();
    return content.length > 0 && !/^[-=~\s]+$/.test(content);
  });
  if (verdict === 'FAIL' && !hasExplanation) {
    throw new Error('Reviewer FAIL must include an explanation beyond review profile metadata. Rerun the review; no actionable code finding was supplied.');
  }
  const fallback = 'No blocking issues were identified against the provided criteria.';
  const normalized = [`VERDICT: ${verdict}`, '', details || fallback].join('\n');
  return {
    verdict,
    title: verdict === 'PASS' ? '✅ Approved' : '❌ Changes requested',
    summary: normalized.substring(0, 65535),
    normalized,
    reviewMarkdown: reviewMarkdown || fallback,
  };
}

export function combineChunkedReviewResponses(chunks: Array<{ label: string; parsed: ParsedReviewResponse }>): ParsedReviewResponse {
  if (chunks.length === 0) throw new Error('Cannot combine an empty set of review responses.');
  if (chunks.length === 1) return chunks[0].parsed;
  const failures = chunks.filter(({ parsed }) => parsed.verdict === 'FAIL');
  const verdict: ReviewVerdict = failures.length > 0 ? 'FAIL' : 'PASS';
  const relevant = failures.length > 0 ? failures : chunks;
  // Diagnostics retain every segment and profile, including successful segments.
  // Never aggregate summary: it is a bounded preview, not the full response.
  const normalized = [`VERDICT: ${verdict}`, '', ...chunks.map(({ label, parsed }) =>
    `## ${label}\n\n${parsed.normalized}`)].join('\n\n');
  return {
    verdict,
    title: verdict === 'PASS' ? '✅ Approved' : '❌ Changes requested',
    summary: normalized.substring(0, 65535),
    normalized,
    reviewMarkdown: relevant.map(({ parsed }) => parsed.reviewMarkdown).join('\n\n---\n\n'),
  };
}

/** Only link supplied locations that can be verified against the reviewed diff. */
export function linkReviewedLocations(markdown: string, source: { owner: string; repo: string; headSha: string; diff: string }): string {
  if (source.headSha.length !== 40 || /[\x00-\x20\x7f]/.test(source.owner + source.repo + source.headSha)
    || !/^[a-f0-9]{40}$/i.test(source.headSha)
    || !/^[A-Za-z0-9_-]+$/.test(source.owner)
    || !/^[A-Za-z0-9_.-]+$/.test(source.repo) || /^\.+$/.test(source.repo)) return markdown;
  const locations = new Map<string, Set<number>>();
  let path: string | undefined;
  let expectedPath: string | undefined;
  let lineNumber: number | undefined;
  let remaining = 0;
  for (const line of source.diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      path = undefined; lineNumber = undefined; remaining = 0;
      expectedPath = line.match(/^diff --git a\/.+? b\/(.+)$/)?.[1];
    }
    if (!path && lineNumber === undefined && line.startsWith('+++ b/')) {
      const candidate = line.slice(6);
      if (candidate === expectedPath && candidate.split('/').every((part) => part && part !== '.' && part !== '..') && !/[\\\x00-\x1f]/.test(candidate)) {
        path = candidate;
        if (!locations.has(path)) locations.set(path, new Set());
      }
      lineNumber = undefined;
    } else if (line.startsWith('@@ ')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      lineNumber = hunk ? Number(hunk[1]) : undefined;
      remaining = hunk ? Number(hunk[2] ?? 1) : 0;
    } else if (path && lineNumber !== undefined && remaining > 0 && (line.startsWith('+') || line.startsWith(' '))) {
      locations.get(path)!.add(lineNumber++);
      remaining--;
    }
  }
  const encode = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return mapOutsideFences(markdown, (line) => line.replace(
    /\[[^\]\n]*\]\([^\n]*?\)|`([^`\n]+):(\d+)(?:-(\d+))?`|(?<![\w/.:`])([A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?(?![\w\d])/g,
    (match, codePath: string, codeStart: string, codeEnd: string, plainPath: string, plainStart: string, plainEnd: string) => {
      const file = codePath || plainPath;
      if (!file) return match; // Existing Markdown links stay untouched.
      const start = Number(codeStart || plainStart);
      const end = Number(codeEnd || plainEnd || start);
      if (String(start) !== (codeStart || plainStart) || ((codeEnd || plainEnd) && String(end) !== (codeEnd || plainEnd))) return match;
      const known = locations.get(file);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || !known?.has(start) || !known.has(end)) return match;
      const url = `https://github.com/${source.owner}/${source.repo}/blob/${source.headSha}/${file.split('/').map(encode).join('/')}#L${start}${end === start ? '' : `-L${end}`}`;
      return `[${match}](${url})`;
    },
  ));
}

/** Present persisted legacy/current summaries without claiming unavailable historic data. */
export function readableReviewSummary(summary: string): string {
  if (!/^\s*\**VERDICT:\s*(PASS|FAIL)\b/i.test(summary)) return summary;
  const chunkMarker = '\u0000review-segment\u0000';
  const segmented = mapOutsideFences(summary, (line) => line.replace(/^## ([^\n]+ \(\d+\/\d+\))\s*$/, `${chunkMarker}$1${chunkMarker}`)).split(chunkMarker);
  if (segmented.length > 1 && /^\s*\**VERDICT:\s*(?:PASS|FAIL)\**\s*$/i.test(segmented[0])) {
    try {
      const chunks = [];
      for (let index = 1; index < segmented.length; index += 2) {
        chunks.push({ label: segmented[index], parsed: parseReviewResponse(segmented[index + 1]) });
      }
      return combineChunkedReviewResponses(chunks).reviewMarkdown;
    } catch { /* Older/partial summaries may not follow the current chunk format. */ }
  }
  const content = mapOutsideFences(summary, (line) => {
    const verdict = line.match(/^\s*\**VERDICT:\s*(?:PASS|FAIL)\b\**(.*)$/i);
    if (verdict) return verdict[1].replace(/^\s*[-–—:]\s*/, '').trim() || null;
    if (/^## [^\n]+ \(\d+\/\d+\)\s*$/.test(line)) return null;
    return line.replace(/^(\s*[-*]\s+)\[[^\]\n]+ \(\d+\/\d+\)\]\s+/, '$1');
  });
  const readable = withoutProfileMetadata(content);
  return readable || 'No finding text was stored. Expand review details for the persisted review status.';
}

export function buildPRReviewBody(parsed: ParsedReviewResponse, source: Parameters<typeof linkReviewedLocations>[1], detailsUrl: string): string {
  const content = linkReviewedLocations(parsed.reviewMarkdown, source);
  const header = `## ${parsed.title}\n\n`;
  const footer = `\n\n---\n*[View full details](${detailsUrl})*`;
  const notice = '\n\n_Review exceeds GitHub’s display limit; remaining findings are available in full details._';
  const budget = 65000 - header.length - footer.length;
  if (content.length <= budget) return header + content + footer;
  let preview = content.slice(0, budget - notice.length);
  // Do not strand the overflow notice/details link inside an unfinished code block.
  let open: { marker: string; offset: number } | undefined;
  let offset = 0;
  for (const line of preview.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!open) open = { marker: marker[1], offset };
      else if (marker[1][0] === open.marker[0] && marker[1].length >= open.marker.length && !marker[2].trim()) open = undefined;
    }
    offset += line.length + 1;
  }
  if (open) preview = preview.slice(0, open.offset);
  return header + preview + notice + footer;
}
