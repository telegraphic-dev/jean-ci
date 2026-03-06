import { NextRequest, NextResponse } from 'next/server';
import { getTask, getTaskExecutions } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/executions - Get execution history for a task
export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id } = await params;
  const taskId = parseInt(id, 10);
  if (isNaN(taskId)) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const task = await getTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const executions = await getTaskExecutions(taskId, limit, offset);

    return NextResponse.json({ 
      task: { id: task.id, name: task.name },
      executions,
      pagination: { limit, offset, count: executions.length },
    });
  } catch (error: any) {
    console.error('Error fetching executions:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
