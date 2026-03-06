import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTaskEvents, getTaskSummary, getTaskStats } from '@/lib/db';

// GET /api/tasks - List task events or summary
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'summary'; // summary | events
  const repo = url.searchParams.get('repo') || undefined;
  const taskName = url.searchParams.get('task') || undefined;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    if (view === 'summary') {
      const [summary, stats] = await Promise.all([
        getTaskSummary(repo),
        getTaskStats(),
      ]);
      return NextResponse.json({ summary, stats });
    } else {
      const { events, total } = await getTaskEvents({ repo, taskName, limit, offset });
      const stats = await getTaskStats();
      return NextResponse.json({ events, total, stats, limit, offset });
    }
  } catch (error: any) {
    console.error('Error fetching tasks:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
