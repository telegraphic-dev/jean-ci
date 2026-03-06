import { NextRequest, NextResponse } from 'next/server';
import { checkDueTasks, getTaskSchedule } from '@/lib/task-runner';

// Shared secret for cron endpoint (prevents unauthorized execution)
const CRON_SECRET = process.env.CRON_SECRET;

// GET /api/tasks/cron - Show task schedule (no auth required)
export async function GET() {
  try {
    const schedule = await getTaskSchedule();
    return NextResponse.json({ 
      schedule,
      count: schedule.length,
    });
  } catch (error: any) {
    console.error('Error fetching schedule:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/tasks/cron - Execute due tasks (requires CRON_SECRET)
// Call this endpoint from:
// - Vercel cron
// - Coolify scheduled task
// - External scheduler (e.g., cron job calling curl)
export async function POST(request: NextRequest) {
  // Verify secret
  const authHeader = request.headers.get('authorization');
  const providedSecret = authHeader?.replace('Bearer ', '') || 
                         request.headers.get('x-cron-secret');

  if (CRON_SECRET && providedSecret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Also allow Vercel cron requests
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!CRON_SECRET && !isVercelCron) {
    // If no secret configured and not a Vercel cron, require auth
    return NextResponse.json(
      { error: 'CRON_SECRET not configured and not a Vercel cron request' },
      { status: 401 }
    );
  }

  try {
    console.log('[Cron] Checking for due tasks...');
    const result = await checkDueTasks();
    
    console.log(`[Cron] Executed ${result.executed} tasks`);
    
    return NextResponse.json({
      message: `Executed ${result.executed} tasks`,
      ...result,
    });
  } catch (error: any) {
    console.error('Error running cron check:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
