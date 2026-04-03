import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAllRepoFeatureSessions } from '@/lib/db';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const sessions = await getAllRepoFeatureSessions();
  return NextResponse.json(sessions);
}
