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

  if (body.selectedChecks != null && !Array.isArray(body.selectedChecks)) {
    return badRequest('selectedChecks must be an array');
  }

  const selectedChecks = Array.isArray(body.selectedChecks)
    ? body.selectedChecks.filter((name): name is string => typeof name === 'string').map((name) => name.trim())
    : undefined;

  if (selectedChecks && selectedChecks.some((name) => !name)) {
    return badRequest('selectedChecks must contain only non-empty strings');
  }

  try {
    const result = await runLocalReview({
      repo: body.repo,
      title: typeof body.title === 'string' ? body.title : null,
      body: typeof body.body === 'string' ? body.body : null,
      diff: body.diff,
      selectedChecks,
      headSha: typeof body.headSha === 'string' ? body.headSha : null,
      ref: typeof body.ref === 'string' ? body.ref : null,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local review failed';
    return badRequest(message);
  }
}
