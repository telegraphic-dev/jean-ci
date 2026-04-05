import { buildPromptValidationSummary, parseReviewResponse, validateReviewPrompt } from './review-output.ts';
import type { ReviewSessionMetadata } from './llm.ts';

export interface LocalReviewCheckInput {
  name: string;
  prompt: string;
}

type ReviewerResult =
  | { success: true; response: string }
  | { success: false; error: string; errorType: 'gateway' | 'unknown' };

interface LocalReviewDeps {
  getUserPrompt: () => Promise<string>;
  callReviewer: (prompt: string, context?: string, metadata?: ReviewSessionMetadata) => Promise<ReviewerResult>;
}

export interface LocalReviewRequest {
  repo: string;
  title?: string | null;
  body?: string | null;
  diff: string;
  checks?: LocalReviewCheckInput[];
  selectedChecks?: string[];
  headSha?: string | null;
  __deps?: Partial<LocalReviewDeps>;
}

export interface LocalReviewCheckResult {
  name: string;
  verdict: 'PASS' | 'FAIL';
  title: string;
  summary: string;
  normalized: string;
  isGlobal: boolean;
}

export interface LocalReviewValidationFailure {
  name: string;
  isGlobal: boolean;
  summary: string;
}

export interface LocalReviewExecutionFailure {
  name: string;
  isGlobal: boolean;
  errorType: 'gateway' | 'unknown';
  error: string;
}

export interface LocalReviewResponse {
  repo: string;
  checks: LocalReviewCheckResult[];
  validationFailures: LocalReviewValidationFailure[];
  executionFailures: LocalReviewExecutionFailure[];
}

interface PreparedCheck {
  name: string;
  prompt: string;
  isGlobal: boolean;
}

const DIFF_LLM_LIMIT = parseInt(process.env.DIFF_LLM_LIMIT || '200000', 10);
const LOCAL_REVIEW_MAX_DIFF = parseInt(process.env.LOCAL_REVIEW_MAX_DIFF || `${DIFF_LLM_LIMIT}`, 10);
const LOCAL_REVIEW_MAX_CHECKS = parseInt(process.env.LOCAL_REVIEW_MAX_CHECKS || '20', 10);

function truncateDiff(diff: string, limit: number): string {
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

function buildReviewContext(
  input: Pick<LocalReviewRequest, 'title' | 'body' | 'diff'>,
): string {
  return [
    `# Pull Request: ${input.title?.trim() || 'Local review'}`,
    '',
    '## Description',
    input.body?.trim() || 'No description provided',
    '',
    '## Diff',
    '```diff',
    truncateDiff(input.diff, DIFF_LLM_LIMIT),
    '```',
  ].join('\n');
}

function normalizeChecks(userPrompt: string, inputChecks: LocalReviewCheckInput[] = []): PreparedCheck[] {
  return [
    { name: 'Code Review', prompt: userPrompt, isGlobal: true },
    ...inputChecks
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((check) => ({ name: check.name, prompt: check.prompt, isGlobal: false })),
  ];
}

function filterChecks(checks: PreparedCheck[], selectedChecks?: string[]): PreparedCheck[] {
  if (!selectedChecks || selectedChecks.length === 0) {
    return checks;
  }

  const selected = new Set(selectedChecks.map((name) => name.trim()).filter(Boolean));
  return checks.filter((check) => selected.has(check.name));
}

function normalizeRepo(repo: string): string {
  return repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/^github\.com\//, '').replace(/^\/+|\/+$/g, '');
}

function buildSessionMetadata(repo: string, promptName: string, headSha?: string | null): ReviewSessionMetadata {
  const [owner = 'local', repoName = 'unknown-repo'] = repo.split('/');
  return {
    owner,
    repo: repoName,
    prNumber: 'local',
    promptName,
    headSha: headSha?.trim() || 'local-diff',
  };
}

export async function runLocalReview(input: LocalReviewRequest): Promise<LocalReviewResponse> {
  const repo = normalizeRepo(input.repo || '');
  if (!repo) {
    throw new Error('repo is required');
  }

  const diff = input.diff || '';
  if (!diff.trim()) {
    throw new Error('diff is required');
  }

  if (diff.length > LOCAL_REVIEW_MAX_DIFF) {
    throw new Error(`diff exceeds LOCAL_REVIEW_MAX_DIFF (${LOCAL_REVIEW_MAX_DIFF} chars)`);
  }

  const deps: LocalReviewDeps = {
    getUserPrompt: async () => {
      const { DEFAULT_USER_PROMPT, getConfig } = await import('./db.ts');
      return (await getConfig('user_prompt')) || DEFAULT_USER_PROMPT;
    },
    callReviewer: async (prompt, context = '', metadata = {}) => {
      const { callOpenClaw } = await import('./llm.ts');
      return callOpenClaw(prompt, context, metadata);
    },
    ...input.__deps,
  };

  const userPrompt = await deps.getUserPrompt();
  const preparedChecks = filterChecks(normalizeChecks(userPrompt, input.checks || []), input.selectedChecks);

  if (preparedChecks.length === 0) {
    throw new Error('No checks selected');
  }

  if (preparedChecks.length > LOCAL_REVIEW_MAX_CHECKS) {
    throw new Error(`too many checks requested (max ${LOCAL_REVIEW_MAX_CHECKS})`);
  }

  const reviewContext = buildReviewContext(input);
  const checks: LocalReviewCheckResult[] = [];
  const validationFailures: LocalReviewValidationFailure[] = [];
  const executionFailures: LocalReviewExecutionFailure[] = [];

  for (const check of preparedChecks) {
    if (!check.isGlobal) {
      const promptValidation = validateReviewPrompt(check.prompt);
      if (!promptValidation.valid) {
        validationFailures.push({
          name: check.name,
          isGlobal: false,
          summary: buildPromptValidationSummary(promptValidation.errors),
        });
        continue;
      }
    }

    const result = await deps.callReviewer(check.prompt, reviewContext, buildSessionMetadata(repo, check.isGlobal ? 'review' : check.name, input.headSha));
    if (!result.success) {
      executionFailures.push({
        name: check.name,
        isGlobal: check.isGlobal,
        errorType: result.errorType,
        error: result.error,
      });
      continue;
    }

    const parsed = parseReviewResponse(result.response);
    checks.push({
      name: check.name,
      verdict: parsed.verdict,
      title: parsed.title,
      summary: parsed.summary,
      normalized: parsed.normalized,
      isGlobal: check.isGlobal,
    });
  }

  return {
    repo,
    checks,
    validationFailures,
    executionFailures,
  };
}
