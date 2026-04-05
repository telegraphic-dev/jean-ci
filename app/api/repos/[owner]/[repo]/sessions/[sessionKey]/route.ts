import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getRepo } from '@/lib/db';
import { getRepoFeatureSessionChat, sendRepoFeatureSessionChatMessage } from '@/lib/repo-feature-session-chat';

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
    const state = await getRepoFeatureSessionChat(fullName, decodeURIComponent(sessionKey));
    return NextResponse.json(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load feature session chat';
    const status = message === 'Feature session not found' ? 404 : 502;
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

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';

  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  try {
    const state = await sendRepoFeatureSessionChatMessage(fullName, decodeURIComponent(sessionKey), message);
    return NextResponse.json(state);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to send feature session message';
    const status = errorMessage === 'Feature session not found' ? 404 : 502;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
