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

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function serverError(message: string) {
  return NextResponse.json({ error: message }, { status: 500 });
}

function isClientValidationError(message: string): boolean {
  return [
    'repo is required',
    'repo must be in owner/repo format',
    'diff is required',
    'headSha or ref is required',
    'headSha/ref contains invalid characters',
    'No checks selected',
    'too many checks requested',
  ].some((prefix) => message === prefix || message.startsWith(`${prefix} (`));
}

export async function POST(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  let body: LocalReviewRequestBody;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (!body || typeof body !== 'object') {
    return badRequest('Request body must be a JSON object');
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
    const message = error instanceof Error ? error.message : 'Local review failed';
    return isClientValidationError(message) ? badRequest(message) : serverError(message);
  }
}
