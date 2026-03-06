import { NextRequest, NextResponse } from 'next/server';
import { runSync } from '@/lib/sync';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  // Verify cron secret if configured
  if (CRON_SECRET) {
    const secret = req.headers.get('x-cron-secret');
    if (secret !== CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  
  try {
    const result = await runSync();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[Sync] Error:', error);
    return NextResponse.json({
      success: false,
      error: error.message,
    }, { status: 500 });
  }
}

// Also support POST for flexibility
export async function POST(req: NextRequest) {
  return GET(req);
}
