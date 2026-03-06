# Scheduled Task Monitoring - Implementation Summary

## Overview

Added comprehensive scheduled task monitoring to jean-ci. Tasks can be global or repo-bound, and execute health checks, webhooks, or LLM-powered validations on a cron schedule.

## What Was Built

### 1. Database Schema

**Tables:**
- `jean_ci_tasks` - Task definitions (cron, type, config, repo scope)
- `jean_ci_task_executions` - Execution history with status, logs, duration

**Indexes:**
- Tasks by repo, enabled status
- Executions by task_id and timestamp

### 2. Task Runner (`lib/task-runner.ts`)

**Execution modes:**
- **Serverless** (recommended): External cron calls `/api/tasks/cron`
- **Persistent**: In-process scheduler with `croner` library

**Task types:**
- `health_check` - HTTP endpoint verification
- `webhook` - HTTP POST/GET with response validation
- `llm_check` - OpenClaw LLM analysis of data/logs
- `command` - Shell commands (disabled in serverless)

**Features:**
- Cron validation and next-run calculation
- Timeout handling
- OpenClaw session notifications on failure
- Execution tracking (status, duration, output, errors)

### 3. API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks` | GET | List all tasks (optionally with stats) |
| `/api/tasks` | POST | Create new task |
| `/api/tasks/:id` | GET | Get task details + last execution |
| `/api/tasks/:id` | PATCH | Update task |
| `/api/tasks/:id` | DELETE | Delete task |
| `/api/tasks/:id/run` | POST | Manually trigger task |
| `/api/tasks/:id/executions` | GET | Get execution history |
| `/api/tasks/stats` | GET | Aggregated statistics |
| `/api/tasks/sync` | POST | Sync tasks from `.jean-ci/tasks.yml` |
| `/api/tasks/cron` | GET | View task schedule |
| `/api/tasks/cron` | POST | Execute due tasks (for external cron) |

All endpoints require authentication via iron-session.

### 4. Admin UI (`app/admin/tasks/page.tsx`)

**Features:**
- Task list with status indicators (enabled/disabled dot)
- Stats cards: total, enabled, global, repo-bound, 24h runs/failures
- Quick actions: toggle enabled, run now, delete
- Task detail modal with execution history
- Create task form
- Real-time status badges (success/failure/running)

**UX:**
- Color-coded status badges (green=success, red=failure)
- Type badges (health_check, webhook, llm_check)
- Execution timeline with expandable logs
- Duration display (ms/seconds)

### 5. Repository Configuration

**`.jean-ci/tasks.yml` format:**
```yaml
tasks:
  - name: "Task Name"
    cron: "0 * * * *"
    type: health_check
    config:
      url: "https://example.com/health"
      expected_status: 200
```

**Sync flow:**
1. User creates `.jean-ci/tasks.yml` in repo
2. Call `/api/tasks/sync` with repo name
3. jean-ci fetches file via GitHub API
4. Parses YAML and upserts to database
5. Removes tasks no longer in config

### 6. Execution Trigger

**Serverless (recommended):**
Create a Coolify scheduled task or Vercel cron:
```bash
curl -X POST https://jean-ci.example.com/api/tasks/cron \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Persistent:**
Set `TASK_RUNNER_ENABLED=true` and tasks run in-process.

### 7. Notifications

When `notify_on_failure: true` and `notify_session` is set, failures send:
```
⚠️ Scheduled Task Failed
Task: API Health Check
Type: health_check
Repo: owner/repo
Error: Expected status 200, got 503
```

Uses OpenClaw gateway `/api/send` endpoint.

## Environment Variables

```bash
TASK_RUNNER_ENABLED=false              # true for persistent mode
TASK_DEFAULT_TIMEOUT_SECONDS=300       # Task execution timeout
CRON_SECRET=your-secret                # Protect cron endpoint
OPENCLAW_GATEWAY_URL=http://...        # For notifications & LLM checks
OPENCLAW_GATEWAY_TOKEN=xxx             # Gateway auth token
```

## Dashboard Integration

**Added to `/admin`:**
- Tasks card showing total tasks + 24h failures
- Link to `/admin/tasks`

**Navigation:**
- Added "⏰ Tasks" to admin layout nav

## Database Migration

Schema is auto-applied on app startup via `initDatabase()` in `lib/db.ts`.

Existing deployments will automatically create tables on next restart.

## Coolify Integration Strategy

**Option 1: Coolify Scheduled Task (Recommended)**
1. Create a Coolify scheduled task for jean-ci app
2. Frequency: `*/5 * * * *` (every 5 minutes, or adjust)
3. Command:
   ```bash
   curl -X POST http://jean-ci:3000/api/tasks/cron \
     -H "Authorization: Bearer ${CRON_SECRET}"
   ```

**Option 2: External Cron**
Use a dedicated cron job on the host to call the endpoint.

**Option 3: Persistent Mode**
Set `TASK_RUNNER_ENABLED=true` but this requires the container to stay running (not ideal for serverless Next.js).

## Testing

**Manual testing:**
1. Go to `/admin/tasks`
2. Create a health check task:
   - Name: "Test Health"
   - Cron: `* * * * *` (every minute)
   - Type: `health_check`
   - URL: `https://httpbin.org/status/200`
3. Click "Run" to test immediately
4. Check execution history
5. Set up external cron to call `/api/tasks/cron` every 5 minutes
6. Verify tasks execute automatically

## Next Steps (Future Enhancements)

1. **Task templates** - Pre-built task configs for common scenarios
2. **Webhook payload support** - Custom request bodies for webhook tasks
3. **Consecutive failure threshold** - Only notify after N failures
4. **Task dependencies** - Run tasks in sequence
5. **Coolify event integration** - React to Coolify deployment/container events
6. **Metrics export** - Prometheus/Grafana integration
7. **Task history retention** - Auto-cleanup old executions

## Files Changed

**New files:**
- `lib/task-runner.ts` - Task execution engine
- `app/api/tasks/route.ts` - List/create tasks
- `app/api/tasks/[id]/route.ts` - CRUD operations
- `app/api/tasks/[id]/run/route.ts` - Manual trigger
- `app/api/tasks/[id]/executions/route.ts` - Execution history
- `app/api/tasks/stats/route.ts` - Statistics
- `app/api/tasks/sync/route.ts` - Repo config sync
- `app/api/tasks/cron/route.ts` - External cron endpoint
- `app/admin/tasks/page.tsx` - Admin UI
- `docs/SCHEDULED_TASKS.md` - Feature design doc
- `docs/SCHEDULED_TASKS_IMPLEMENTATION.md` - This file

**Modified files:**
- `lib/db.ts` - Added task schema + CRUD functions
- `app/admin/layout.tsx` - Added Tasks nav item
- `app/admin/page.tsx` - Added Tasks stats card
- `package.json` - Added `croner` dependency
- `README.md` - Added Scheduled Tasks documentation

## Build Status

✅ `npm run build` passes
✅ TypeScript compilation successful
✅ All routes properly authenticated

Ready for deployment.
