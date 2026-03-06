# Scheduled Task Monitoring

## Overview

jean-ci can monitor and manage scheduled tasks across repositories. Tasks can be:
- **Global tasks**: Defined in jean-ci admin, run across all configured repos
- **Repo-bound tasks**: Defined in `.jean-ci/tasks.yml`, scoped to specific repos

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     jean-ci Task Monitor                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Global Tasks │    │  Repo Tasks  │    │   Coolify    │  │
│  │ (admin UI)   │    │ (.jean-ci/)  │    │  (webhooks)  │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │           │
│         └─────────┬─────────┴─────────┬─────────┘           │
│                   ▼                   ▼                     │
│         ┌─────────────────┐  ┌─────────────────┐           │
│         │  Task Registry  │  │   Executions    │           │
│         │  (definitions)  │  │   (history)     │           │
│         └─────────────────┘  └─────────────────┘           │
│                   │                   │                     │
│                   └─────────┬─────────┘                     │
│                             ▼                               │
│                   ┌─────────────────┐                       │
│                   │   Dashboard &   │                       │
│                   │   API           │                       │
│                   └─────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

### Tasks Table (`jean_ci_tasks`)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| name | TEXT | Human-readable task name |
| cron_expression | TEXT | Cron schedule (e.g., `0 9 * * *`) |
| repo | TEXT | NULL for global, `owner/repo` for repo-bound |
| task_type | TEXT | `command`, `webhook`, `health_check`, `llm_check` |
| config | JSONB | Type-specific config (command, URL, prompt, etc.) |
| enabled | BOOLEAN | Whether task is active |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last update |

### Executions Table (`jean_ci_task_executions`)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| task_id | INTEGER | FK to tasks |
| status | TEXT | `pending`, `running`, `success`, `failure`, `timeout` |
| started_at | TIMESTAMP | Execution start |
| completed_at | TIMESTAMP | Execution end |
| duration_ms | INTEGER | Runtime in milliseconds |
| output | TEXT | Stdout/result |
| error | TEXT | Stderr/error message |
| trigger | TEXT | `cron`, `manual`, `webhook` |

## Task Types

### 1. Command Tasks
Run shell commands in a container or via exec.

```yaml
task_type: command
config:
  command: "npm run backup"
  working_dir: "/app"
  timeout_seconds: 300
```

### 2. Webhook Tasks
Call an HTTP endpoint and verify response.

```yaml
task_type: webhook
config:
  url: "https://api.example.com/cron/cleanup"
  method: "POST"
  headers:
    Authorization: "Bearer ${SECRET_TOKEN}"
  expected_status: 200
```

### 3. Health Check Tasks
Verify service availability.

```yaml
task_type: health_check
config:
  url: "https://app.example.com/api/health"
  method: "GET"
  expected_status: 200
  expected_body_contains: "ok"
  timeout_ms: 5000
```

### 4. LLM Check Tasks
Run LLM-powered verification (via OpenClaw gateway).

```yaml
task_type: llm_check
config:
  prompt: |
    Check the following metrics and report any anomalies:
    - Response time should be < 500ms
    - Error rate should be < 1%
  data_url: "https://api.example.com/metrics"
  model: "claude-sonnet"
```

## Repo Configuration

`.jean-ci/tasks.yml`:

```yaml
tasks:
  - name: "Database Backup"
    cron: "0 3 * * *"
    type: health_check
    config:
      url: "${APP_URL}/api/cron/backup"
      method: "POST"
      expected_status: 200

  - name: "Cache Cleanup"
    cron: "0 */6 * * *"
    type: webhook
    config:
      url: "${APP_URL}/api/cron/cache-clear"

  - name: "Daily Report"
    cron: "0 9 * * MON-FRI"
    type: llm_check
    config:
      prompt: "Analyze yesterday's error logs and summarize issues"
      data_url: "${APP_URL}/api/admin/logs?date=yesterday"
```

## API Endpoints

### Tasks CRUD
- `GET /api/tasks` - List all tasks (global + repo)
- `GET /api/tasks/:id` - Get task details
- `POST /api/tasks` - Create global task
- `PATCH /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task
- `POST /api/tasks/:id/run` - Trigger manual run

### Executions
- `GET /api/tasks/:id/executions` - List task execution history
- `GET /api/executions/:id` - Get execution details with logs

### Stats
- `GET /api/tasks/stats` - Aggregated stats (success rate, avg duration)

## Dashboard Features

### Task List View
- Name, cron, last run status, last run time, next run
- Quick toggle enable/disable
- Manual trigger button
- Link to execution history

### Execution History
- Timeline of runs with status badges
- Expandable output/error logs
- Duration and trigger source

### Alerts
- Email/webhook notifications on:
  - Task failure
  - Task timeout
  - Consecutive failures (configurable threshold)

## Implementation Plan

1. **Phase 1: Database & Core**
   - Add database tables
   - Task CRUD API
   - Execution logging

2. **Phase 2: Task Runner**
   - Cron scheduler (node-cron)
   - Health check executor
   - Webhook executor

3. **Phase 3: Dashboard**
   - Admin UI pages
   - Execution history view
   - Manual trigger

4. **Phase 4: Notifications**
   - OpenClaw session notifications
   - Webhook alerts
   - Email (optional)

## Environment Variables

```bash
# Task runner
TASK_RUNNER_ENABLED=true
TASK_DEFAULT_TIMEOUT_SECONDS=300

# Notifications
TASK_NOTIFY_ON_FAILURE=true
TASK_NOTIFY_CONSECUTIVE_FAILURES=3
OPENCLAW_GATEWAY_URL=http://coolify-proxy/openclaw
OPENCLAW_GATEWAY_TOKEN=xxx
```
