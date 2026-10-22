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

export function parseReviewResponse(response: string): ParsedReviewResponse {
  const trimmed = response.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  const firstMeaningfulLine = lines.find((line) => line.length > 0) || '';
  const verdictMatch = firstMeaningfulLine.match(/^\**VERDICT:\s*(PASS|FAIL)\b\**(.*)$/i);

  if (!verdictMatch) {
    throw new Error('Reviewer response must start with "VERDICT: PASS" or "VERDICT: FAIL" on the first non-empty line.');
  }

  const verdict = verdictMatch[1].toUpperCase() as ReviewVerdict;
  // Prose and continuation lines carry findings too. Selecting only bullets
  // silently drops them as soon as the reviewer adds a profile metadata bullet.
  const inlineExplanation = verdictMatch[2].replace(/^\s*[-–—:]\s*/, '').trim();
  const details = [inlineExplanation, ...lines.slice(lines.indexOf(firstMeaningfulLine) + 1)]
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  const hasExplanation = details.some((line) => {
    const content = line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
    return content.length > 0
      && !/^[-=~\s]+$/.test(content)
      && !/^review profile\s*:/i.test(content)
      && !/^(?:(?:diff|repository|tests)\s*=\s*[^;]+;?\s*)+$/i.test(content);
  });
  if (verdict === 'FAIL' && !hasExplanation) {
    // The caller reports a failed review execution, not REQUEST_CHANGES.
    // Do not turn a malformed reviewer response into a code finding or a PASS.
    throw new Error('Reviewer FAIL must include an explanation beyond review profile metadata. Rerun the review; no actionable code finding was supplied.');
  }
  const normalizedBullets = details.map((line) => `- ${line}`);

  const fallbackLine = verdict === 'PASS'
    ? '- No blocking issues were identified against the provided criteria.'
    : '- Blocking issues were identified, but the reviewer did not provide a structured explanation.';

  const normalized = [`VERDICT: ${verdict}`, '', ...(normalizedBullets.length ? normalizedBullets : [fallbackLine])].join('\n');

  return {
    verdict,
    title: verdict === 'PASS' ? '✅ Approved' : '❌ Changes requested',
    summary: normalized.substring(0, 65535),
    normalized,
  };
}

export function combineChunkedReviewResponses(chunks: Array<{ label: string; parsed: ParsedReviewResponse }>): ParsedReviewResponse {
  if (chunks.length === 0) {
    throw new Error('Cannot combine an empty set of review responses.');
  }
  if (chunks.length === 1) return chunks[0].parsed;

  const failures = chunks.filter(({ parsed }) => parsed.verdict === 'FAIL');
  const verdict: ReviewVerdict = failures.length > 0 ? 'FAIL' : 'PASS';
  const relevant = failures.length > 0 ? failures : chunks;
  const findings = relevant.flatMap(({ label, parsed }) =>
    parsed.summary.split(/\r?\n/).filter((line) => /^-\s+/.test(line)).map((line) => `- [${label}] ${line.replace(/^-\s+/, '')}`),
  );
  const normalized = [
    `VERDICT: ${verdict}`,
    '',
    ...(findings.length > 0 ? findings : ['- No blocking issues were identified across the reviewed subsystems.']),
  ].join('\n');

  return {
    verdict,
    title: verdict === 'PASS' ? '✅ Approved' : '❌ Changes requested',
    summary: normalized.substring(0, 65535),
    normalized,
  };
}
