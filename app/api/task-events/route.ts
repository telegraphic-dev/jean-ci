import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTaskEvents, getTaskEventStats } from '@/lib/db';

// GET /api/task-events - List scheduled task execution events
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app');
  const task = searchParams.get('task');
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const withStats = searchParams.get('stats') === 'true';

  try {
    const events = await getTaskEvents({ app, task, status, limit });
    
    if (withStats) {
      const stats = await getTaskEventStats();
      return NextResponse.json({ events, stats });
    }

    return NextResponse.json({ events });
  } catch (error: any) {
    console.error('Error fetching task events:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
