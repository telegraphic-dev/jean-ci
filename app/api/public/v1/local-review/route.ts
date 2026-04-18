import { NextRequest, NextResponse } from 'next/server';
import { requirePublicApiToken } from '@/lib/public-api';
import { enqueueLocalReviewRun, getLocalReviewRunStatus } from '@/lib/local-review-runs';

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

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function notFound(message = 'Run not found') {
  return NextResponse.json({ error: message }, { status: 404 });
}

function hasOnlyAllowedKeys(body: Record<string, unknown>): boolean {
  const allowedKeys = new Set(['repo', 'title', 'body', 'diff', 'selectedChecks', 'headSha', 'ref']);
  return Object.keys(body).every((key) => allowedKeys.has(key));
}

function parseAndValidateBody(rawBody: string): LocalReviewRequestBody | { error: string } {
  let body: LocalReviewRequestBody;
  try {
    body = JSON.parse(rawBody) as LocalReviewRequestBody;
  } catch {
    return { error: 'Request body must be valid JSON' };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  if (!hasOnlyAllowedKeys(body as Record<string, unknown>)) {
    return { error: 'Request body contains unknown fields' };
  }

  if (typeof body.repo !== 'string' || body.repo.trim().length === 0) {
    return { error: 'repo is required' };
  }

  if (typeof body.diff !== 'string' || body.diff.trim().length === 0) {
    return { error: 'diff is required' };
  }

  const headSha = typeof body.headSha === 'string' ? body.headSha.trim() : '';
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!headSha && !ref) {
    return { error: 'headSha or ref is required' };
  }

  if (body.selectedChecks != null && !Array.isArray(body.selectedChecks)) {
    return { error: 'selectedChecks must be an array' };
  }

  const selectedChecks = Array.isArray(body.selectedChecks)
    ? body.selectedChecks.map((name) => (typeof name === 'string' ? name.trim() : '__invalid__'))
    : undefined;

  if (selectedChecks && selectedChecks.some((name) => !name || name === '__invalid__')) {
    return { error: 'selectedChecks must contain only non-empty strings' };
  }

  return {
    repo: body.repo.trim(),
    title: typeof body.title === 'string' ? body.title : null,
    body: typeof body.body === 'string' ? body.body : null,
    diff: body.diff,
    selectedChecks,
    headSha: headSha || null,
    ref: ref || null,
  };
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

  const parsed = parseAndValidateBody(rawBody);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }

  const { runId } = await enqueueLocalReviewRun(parsed);

  return NextResponse.json(
    {
      runId,
      status: 'queued',
      pollUrl: `/api/public/v1/local-review/${runId}`,
    },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const url = new URL(req.url);
  const runId = (url.searchParams.get('runId') || '').trim();
  if (!runId) {
    return badRequest('runId is required');
  }

  const status = await getLocalReviewRunStatus(runId);
  if (!status) {
    return notFound();
  }

  return NextResponse.json(status);
}
