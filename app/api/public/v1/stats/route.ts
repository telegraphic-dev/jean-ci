import { NextRequest, NextResponse } from 'next/server';
import { getOpenPRsCount, getPendingDeploymentsCount, getTaskStats } from '@/lib/db';
import { requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const [openPRs, pendingDeploys, tasks] = await Promise.all([
    getOpenPRsCount(),
    getPendingDeploymentsCount(),
    getTaskStats(),
  ]);

  return NextResponse.json({
    openPRs,
    pendingDeploys,
    tasks,
  });
}
