import { NextResponse } from 'next/server';
import { getOpenPRsCount, getPendingDeploymentsCount } from '@/lib/db';

export async function GET() {
  const [openPRs, pendingDeploys] = await Promise.all([
    getOpenPRsCount(),
    getPendingDeploymentsCount(),
  ]);

  return NextResponse.json({
    openPRs,
    pendingDeploys,
  });
}
