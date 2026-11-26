# Jean CI MCP Server

Jean CI exposes a remote **Model Context Protocol (MCP)** server over Streamable HTTP so AI coding agents, IDEs, and desktop hosts can inspect, retrigger, override, and locally test PR reviews alongside CI pipelines, deployments, tasks, and webhook events.

## Protocol & Endpoints

- **Protocol revision**: **MCP `2026-07-28`** (latest stateless per-request envelope, `server/discover`, `resultType`, cache hints, MRTR elicitation) with automatic stateless backward compatibility for **`2025-11-25`** clients.
- **Streamable HTTP endpoint**: `POST /api/mcp`
- **MCP Server Card (SEP-2127)**: `GET /api/mcp/server-card` (`application/mcp-server-card+json`)
- **AI Catalog discovery**: `GET /.well-known/ai-catalog.json` (`application/ai-catalog+json`)

## Authentication

`/api/mcp` uses the same Bearer API token authentication as `/api/public/v1/*`:

- Create a token in the Jean CI Admin UI (stored hashed in `jean_ci_api_tokens`), or configure `PUBLIC_API_TOKEN` / `PUBLIC_API_TOKENS`.
- Send `Authorization: Bearer <token>` on every request to `/api/mcp`.

> **Security boundary**: Browser-session GitHub administrator controls for Hermes tool approvals (`POST /api/checks/{id}/approval` — **Approve once** / **Deny**) are intentionally **not** exposed over bearer-token MCP. When a check is waiting on a tool approval, `get_review_check` returns a safe read-only indicator (`approvalStatus.waitingForApproval: true`) and the authenticated `/checks/<id>` URL for a human admin to open.

## Client Configuration

### Claude Code / Cursor / VS Code / Generic Streamable HTTP

```json
{
  "mcpServers": {
    "jean-ci": {
      "type": "http",
      "url": "https://jean-ci.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${JEAN_CI_API_TOKEN}"
      }
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Select **Streamable HTTP**, enter `https://jean-ci.example.com/api/mcp`, and add the `Authorization: Bearer <token>` header.

## Official MCP Extensions Enabled

| Extension | Identifier | How Jean CI uses it |
| --- | --- | --- |
| **MCP Apps** | `io.modelcontextprotocol/ui` | `get_pr_reviews` and `get_review_check` attach the interactive `ui://jean-ci/review-inspector.html` app view (verdict badges, findings summary, colorized diff preview, check prompt, refresh, and one-click retrigger). |
| **MCP Tasks** | `io.modelcontextprotocol/tasks` | Long-running `retrigger_pr_review` and `run_local_review` calls return a durable PostgreSQL-backed task handle (`resultType: "task"`) for tasks-capable clients to poll via `tasks/get` or cooperatively cancel via `tasks/cancel`. Non-tasks clients degrade gracefully. |
| **Skills over MCP** | `io.modelcontextprotocol/skills` | Publishes verified Agent Skills (`skill://jean-ci/triage-pr-review/SKILL.md` and `skill://jean-ci/author-pr-check/SKILL.md`) with SHA-256 manifests and directory reads (`skills/list`, `skills/get`, `resources/read`, `resources/directory/read`). |
| **MCP Server Cards** | `ext-server-card` (SEP-2127) | Publishes `/.well-known/ai-catalog.json` and `/api/mcp/server-card` with CORS headers and ETag/`304 Not Modified` caching. |
| **MRTR Form Elicitation** | Core `2026-07-28` | Calling `override_pr_review` without a `reason` from a form-elicitation-capable client returns `resultType: "input_required"` to collect the override reason and explicit confirmation before recording the local override. |

## Tools

### PR Reviews
- `list_open_prs` — List open PRs in review-enabled repos (filter by `repo`, `status`, `staleOnly`).
- `list_pr_reviews` — Filter and paginate check runs by `repo`, `prNumber`, `status`, `conclusion`, `checkName`, `headSha`.
- `get_pr_reviews` — Full PR review rollup, review tracking state, latest checks, and run history (MCP App UI).
- `get_review_check` — Deep inspection of a single check run: findings summary, optional prompt & diff preview, override info, and safe approval-wait indicator (MCP App UI).
- `retrigger_pr_review` — Retrigger all checks or a specific `checkNames` subset on an open PR (by `repo`+`prNumber` or `checkId`, with optional `expectedHeadSha` guard; MCP Tasks enabled).
- `override_pr_review` — Record a local Jean CI manual override to PASS on a failed completed check (MRTR Form Elicitation when `reason` is omitted).
- `run_local_review` — Run Jean CI checks (`Code Review` + `.jean-ci/pr-checks/*.md`) against a local unified diff before pushing (MCP Tasks enabled).
- `list_pr_check_definitions` — Inspect active global `Code Review` and `.jean-ci/pr-checks/*.md` prompts at a git ref along with prompt validation results.

### CI & Platform (OpenAPI Parity)
- `get_ci_stats` — Global health, open PRs, pending deployments, and scheduled task stats.
- `list_repos` / `get_repo` — Tracked repositories, settings, and activity counts.
- `list_pipelines` — Build -> package -> deploy pipelines.
- `list_deployments` — Coolify deployments for a repository.
- `list_events` — Recorded GitHub/Coolify webhook events.
- `list_tasks` — Scheduled task summaries or events (outputs redacted, matching `/api/public/v1/tasks`).
- `list_feature_sessions` — OpenClaw feature sessions for a repository.

## Resources & Prompts

- **Resources**: `jean-ci://stats`, `jean-ci://repos`, `jean-ci://prs/open`, `jean-ci://checks/{checkId}`, `jean-ci://repos/{owner}/{repo}/prs/{prNumber}/reviews`, `ui://jean-ci/review-inspector.html`, and `skill://jean-ci/...`.
- **Prompts**: `triage-pr-reviews`, `fix-review-findings`, `draft-pr-check-prompt` (with repository autocompletion).
