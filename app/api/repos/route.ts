import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getReposWithActivity } from '@/lib/db';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const repos = await getReposWithActivity();
  return NextResponse.json(repos);
}
