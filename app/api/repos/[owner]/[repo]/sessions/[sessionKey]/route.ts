import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo } from '@/lib/db';
import { getRepoFeatureSessionChat, sendRepoFeatureSessionChatMessage } from '@/lib/repo-feature-session-chat';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_REQUEST_ID_LENGTH = 256;

type Params = { params: Promise<{ owner: string; repo: string; sessionKey: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { owner, repo, sessionKey } = await params;
  const fullName = `${owner}/${repo}`;
  const repoData = await getRepo(fullName);

  if (!repoData) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  if (!repoData.feature_sessions_enabled) {
    return NextResponse.json({ error: 'Feature sessions are not enabled for this repository' }, { status: 404 });
  }

  try {
    const state = await getRepoFeatureSessionChat(fullName, sessionKey);
    return NextResponse.json(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load feature session chat';
    const status = message === 'Feature session not found'
      ? 404
      : message === 'Feature session key does not belong to this repository'
        ? 400
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { owner, repo, sessionKey } = await params;
  const fullName = `${owner}/${repo}`;
  const repoData = await getRepo(fullName);

  if (!repoData) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  if (!repoData.feature_sessions_enabled) {
    return NextResponse.json({ error: 'Feature sessions are not enabled for this repository' }, { status: 404 });
  }

  const contentLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
  }

  const rawBody = await req.text().catch(() => null);
  if (rawBody == null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (rawBody.length > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';

  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 });
  }

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    return NextResponse.json({ error: `requestId exceeds ${MAX_REQUEST_ID_LENGTH} characters` }, { status: 400 });
  }

  try {
    const state = await sendRepoFeatureSessionChatMessage(fullName, sessionKey, message, requestId);
    const status = state.runStatus === 'timeout'
      ? 504
      : state.runStatus === 'error'
        ? 502
        : state.runStatus === 'running'
          ? 202
          : 200;
    return NextResponse.json(state, { status });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to send feature session message';
    const status = errorMessage === 'Feature session not found'
      ? 404
      : errorMessage === 'Feature session key does not belong to this repository'
        ? 400
        : 502;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
