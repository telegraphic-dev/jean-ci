import { NextRequest, NextResponse } from 'next/server';
import { getTask } from '@/lib/db';
import { executeTask } from '@/lib/task-runner';
import { requireAuth } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/tasks/[id]/run - Manually trigger a task
export async function POST(request: NextRequest, { params }: Params) {
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

    // Execute the task immediately
    const execution = await executeTask(task, 'manual');

    return NextResponse.json({ 
      execution,
      message: execution.status === 'success' ? 'Task completed successfully' : 'Task failed',
    });
  } catch (error: any) {
    console.error('Error running task:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
