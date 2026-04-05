import { NextRequest, NextResponse } from 'next/server';
import { requirePublicApiToken } from '@/lib/public-api';
import { runLocalReview } from '@/lib/local-review';

interface LocalReviewRequestBody {
  repo?: string;
  title?: string | null;
  body?: string | null;
  diff?: string;
  selectedChecks?: string[];
  headSha?: string | null;
  ref?: string | null;
}

const MAX_BODY_BYTES = parseInt(process.env.LOCAL_REVIEW_MAX_BODY_BYTES || '262144', 10);
const GENERIC_SERVER_ERROR = 'Local review failed';

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function serverError(message: string = GENERIC_SERVER_ERROR) {
  return NextResponse.json({ error: message }, { status: 500 });
}

function isClientValidationError(message: string): boolean {
  return [
    'repo is required',
    'repo must be in owner/repo format',
    'repo is not tracked',
    'diff is required',
    'diff exceeds LOCAL_REVIEW_MAX_DIFF',
    'headSha or ref is required',
    'headSha must be a full 40-character commit SHA',
    'headSha/ref contains invalid characters',
    'selectedChecks must be an array',
    'selectedChecks must contain only non-empty strings',
    'No checks selected',
    'too many checks requested',
    'unknown selectedChecks',
  ].some((prefix) => message === prefix || message.startsWith(`${prefix} (`) || message.startsWith(`${prefix}:`));
}

function hasOnlyAllowedKeys(body: Record<string, unknown>): boolean {
  const allowedKeys = new Set(['repo', 'title', 'body', 'diff', 'selectedChecks', 'headSha', 'ref']);
  return Object.keys(body).every((key) => allowedKeys.has(key));
}

export async function POST(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const contentLengthHeader = req.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return badRequest(`Request body too large (max ${MAX_BODY_BYTES} bytes)`);
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return badRequest(`Request body too large (max ${MAX_BODY_BYTES} bytes)`);
  }

  let body: LocalReviewRequestBody;
  try {
    body = JSON.parse(rawBody) as LocalReviewRequestBody;
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('Request body must be a JSON object');
  }

  if (!hasOnlyAllowedKeys(body as Record<string, unknown>)) {
    return badRequest('Request body contains unknown fields');
  }

  if (typeof body.repo !== 'string' || body.repo.trim().length === 0) {
    return badRequest('repo is required');
  }

  if (typeof body.diff !== 'string' || body.diff.trim().length === 0) {
    return badRequest('diff is required');
  }

  const headSha = typeof body.headSha === 'string' ? body.headSha.trim() : '';
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!headSha && !ref) {
    return badRequest('headSha or ref is required');
  }

  if (body.selectedChecks != null && !Array.isArray(body.selectedChecks)) {
    return badRequest('selectedChecks must be an array');
  }

  const selectedChecks = Array.isArray(body.selectedChecks)
    ? body.selectedChecks.map((name) => (typeof name === 'string' ? name.trim() : '__invalid__'))
    : undefined;

  if (selectedChecks && selectedChecks.some((name) => !name || name === '__invalid__')) {
    return badRequest('selectedChecks must contain only non-empty strings');
  }

  try {
    const result = await runLocalReview({
      repo: body.repo,
      title: typeof body.title === 'string' ? body.title : null,
      body: typeof body.body === 'string' ? body.body : null,
      diff: body.diff,
      selectedChecks,
      headSha: headSha || null,
      ref: ref || null,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : GENERIC_SERVER_ERROR;
    return isClientValidationError(message) ? badRequest(message) : serverError();
  }
}
