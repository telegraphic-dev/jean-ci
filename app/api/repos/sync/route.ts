import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { syncReposFromInstallations } from '@/lib/github';
import { getAllRepos } from '@/lib/db';

export async function POST() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  await syncReposFromInstallations();
  const repos = await getAllRepos();
  
  return NextResponse.json({ success: true, count: repos.length, repos });
}
