import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTaskSummary } from '@/lib/db';

// GET /api/task-events/summary - Get task summary (latest status per task)
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const summary = await getTaskSummary();
    return NextResponse.json({ summary });
  } catch (error: any) {
    console.error('Error fetching task summary:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
