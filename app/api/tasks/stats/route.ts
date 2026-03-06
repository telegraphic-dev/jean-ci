import { NextResponse } from 'next/server';
import { getTaskStats, getRecentTaskExecutions } from '@/lib/db';
import { getActiveJobCount } from '@/lib/task-runner';
import { requireAuth } from '@/lib/auth';

// GET /api/tasks/stats - Get task statistics
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const stats = await getTaskStats();
    const recentExecutions = await getRecentTaskExecutions(10);
    const activeJobs = getActiveJobCount();

    return NextResponse.json({ 
      stats: {
        ...stats,
        active_jobs: activeJobs,
      },
      recent_executions: recentExecutions,
    });
  } catch (error: any) {
    console.error('Error fetching stats:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
