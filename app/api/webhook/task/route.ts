import { NextRequest, NextResponse } from 'next/server';
import { insertEvent } from '@/lib/db';

// Webhook endpoint for Coolify scheduled task events
// 
// Coolify tasks should call this endpoint to report their execution status:
//
// Success:
//   curl -sf -X POST https://jean-ci.../api/webhook/task \
//     -H 'Content-Type: application/json' \
//     -d '{"task":"backup","app":"my-app","status":"success","output":"..."}'
//
// Failure (using || to ensure report even on error):
//   my-command || curl -sf -X POST https://jean-ci.../api/webhook/task \
//     -H 'Content-Type: application/json' \
//     -d '{"task":"backup","app":"my-app","status":"failure","error":"..."}'
//
// Full pattern for tasks:
//   output=$(my-command 2>&1) && status="success" || status="failure"; \
//   curl -sf -X POST https://jean-ci.../api/webhook/task \
//     -H 'Content-Type: application/json' \
//     -d "{\"task\":\"$TASK_NAME\",\"app\":\"$APP_UUID\",\"status\":\"$status\",\"output\":\"$output\"}"

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    
    const {
      task,           // Task name (e.g., "backup", "cleanup", "healthcheck")
      app,            // App UUID or name
      repo,           // Optional: repo name for grouping
      status,         // "success", "failure", "started", "timeout"
      output,         // Command output (optional)
      error,          // Error message (optional)
      duration_ms,    // Execution duration in ms (optional)
      cron,           // Cron expression (optional, for display)
      container,      // Container name (optional)
    } = payload;

    if (!task || !status) {
      return NextResponse.json(
        { error: 'Missing required fields: task, status' },
        { status: 400 }
      );
    }

    console.log(`[Task Webhook] ${task} on ${app || 'unknown'}: ${status}`);

    // Store as event with structured payload
    await insertEvent(
      `scheduled_task_${status}`,
      null,  // delivery_id
      repo || app || null,  // repo field for grouping
      status,  // action
      {
        task_name: task,
        app_uuid: app,
        repo,
        status,
        output: output?.substring(0, 10000),  // Limit output size
        error,
        duration_ms,
        cron_expression: cron,
        container,
        received_at: new Date().toISOString(),
      },
      'coolify_task'  // source
    );

    return NextResponse.json({ 
      received: true, 
      task,
      status,
    });
  } catch (e: any) {
    console.error('[Task Webhook] Error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// GET endpoint for testing/health check
export async function GET() {
  return NextResponse.json({ 
    endpoint: 'task-webhook',
    status: 'ok',
    usage: {
      method: 'POST',
      fields: {
        task: 'Task name (required)',
        status: 'success | failure | started | timeout (required)',
        app: 'Coolify app UUID (optional)',
        repo: 'Repository name for grouping (optional)',
        output: 'Command stdout (optional)',
        error: 'Error message (optional)',
        duration_ms: 'Execution time in milliseconds (optional)',
        cron: 'Cron expression (optional)',
        container: 'Container name (optional)',
      },
      example: 'curl -X POST .../api/webhook/task -d \'{"task":"backup","app":"abc123","status":"success"}\'',
    },
  });
}
