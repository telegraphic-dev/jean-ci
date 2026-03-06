import { NextRequest, NextResponse } from 'next/server';
import { 
  getAllTasks, 
  getTasksWithStats, 
  createTask, 
  getTaskStats,
  TaskType,
} from '@/lib/db';
import { scheduleTask } from '@/lib/task-runner';
import { requireAuth } from '@/lib/auth';

// GET /api/tasks - List all tasks
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo');
  const withStats = searchParams.get('stats') === 'true';

  try {
    if (withStats) {
      const tasks = await getTasksWithStats();
      const stats = await getTaskStats();
      return NextResponse.json({ tasks, stats });
    }

    const tasks = await getAllTasks(repo === '' ? null : repo === undefined ? undefined : repo);
    return NextResponse.json({ tasks });
  } catch (error: any) {
    console.error('Error fetching tasks:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name, cron_expression, repo, task_type, config, enabled, notify_on_failure, notify_session } = body;

    if (!name || !cron_expression || !task_type) {
      return NextResponse.json(
        { error: 'Missing required fields: name, cron_expression, task_type' },
        { status: 400 }
      );
    }

    const validTypes: TaskType[] = ['command', 'webhook', 'health_check', 'llm_check'];
    if (!validTypes.includes(task_type)) {
      return NextResponse.json(
        { error: `Invalid task_type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const task = await createTask({
      name,
      cron_expression,
      repo: repo || null,
      task_type,
      config: config || {},
      enabled: enabled ?? true,
      notify_on_failure: notify_on_failure ?? true,
      notify_session: notify_session || null,
    });

    // Schedule the task if enabled
    if (task.enabled) {
      scheduleTask(task);
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (error: any) {
    console.error('Error creating task:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
