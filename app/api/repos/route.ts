import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAllRepos } from '@/lib/db';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const repos = await getAllRepos();
  return NextResponse.json(repos);
}
