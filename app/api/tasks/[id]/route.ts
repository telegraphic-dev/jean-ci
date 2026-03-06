import { NextRequest, NextResponse } from 'next/server';
import { 
  getTask, 
  updateTask, 
  deleteTask,
  getTaskExecutions,
  getLastTaskExecution,
} from '@/lib/db';
import { scheduleTask, unscheduleTask } from '@/lib/task-runner';
import { requireAuth } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id] - Get task details
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
    const includeExecutions = searchParams.get('executions') === 'true';
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    let executions = null;
    let lastExecution = null;

    if (includeExecutions) {
      executions = await getTaskExecutions(taskId, limit);
    } else {
      lastExecution = await getLastTaskExecution(taskId);
    }

    return NextResponse.json({ 
      task, 
      last_execution: lastExecution,
      executions,
    });
  } catch (error: any) {
    console.error('Error fetching task:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update task
export async function PATCH(request: NextRequest, { params }: Params) {
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
    const body = await request.json();
    const task = await updateTask(taskId, body);
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Reschedule task
    if (task.enabled) {
      scheduleTask(task);
    } else {
      unscheduleTask(taskId);
    }

    return NextResponse.json({ task });
  } catch (error: any) {
    console.error('Error updating task:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete task
export async function DELETE(request: NextRequest, { params }: Params) {
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
    unscheduleTask(taskId);
    const deleted = await deleteTask(taskId);
    
    if (!deleted) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting task:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
