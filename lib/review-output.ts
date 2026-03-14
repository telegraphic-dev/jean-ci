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
  const verdictMatch = firstMeaningfulLine.match(/^\**VERDICT:\s*(PASS|FAIL)\**$/i);

  if (!verdictMatch) {
    throw new Error('Reviewer response must start with "VERDICT: PASS" or "VERDICT: FAIL" on the first non-empty line.');
  }

  const verdict = verdictMatch[1].toUpperCase() as ReviewVerdict;
  const detailLines = lines.slice(lines.indexOf(firstMeaningfulLine) + 1).filter(Boolean);
  const bulletLines = detailLines.filter((line) => /^[-*]\s+/.test(line));
  const normalizedBullets = (bulletLines.length ? bulletLines : detailLines)
    .slice(0, 5)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);

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
