import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAllDeployments } from '@/lib/db';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const deployments = await getAllDeployments();
  return NextResponse.json(deployments);
}
