import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getGatewayDashboardStatus } from '@/lib/openclaw-status';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const gateway = await getGatewayDashboardStatus();
  return NextResponse.json({ gateway });
}
