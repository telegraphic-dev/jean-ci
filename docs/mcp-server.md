# Jean CI MCP Server

Jean CI exposes a remote **Model Context Protocol (MCP)** server over Streamable HTTP so AI coding agents, IDEs, and desktop hosts can inspect, retrigger, override, and locally test PR reviews alongside CI pipelines, deployments, tasks, and webhook events.

## Protocol & Endpoints

- **Protocol revision**: **MCP `2026-07-28`** (latest stateless per-request envelope, `server/discover`, `resultType`, cache hints, MRTR elicitation) with automatic stateless backward compatibility for **`2025-11-25`** clients.
- **Streamable HTTP endpoint**: `POST /mcp` (canonical; `/api/mcp` is also supported as a backward-compatible alias).
- **OAuth 2.1 discovery**:
  - `GET /.well-known/oauth-protected-resource` & `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728)
  - `GET /.well-known/oauth-authorization-server` (RFC 8414)
  - `POST /oauth/register` (RFC 7591 Dynamic Client Registration) + Client ID Metadata Documents (CIMD)
  - `GET/POST /oauth/authorize` (PKCE S256 + GitHub admin sign-in & consent)
  - `POST /oauth/token` (authorization code + rotating refresh tokens) and `POST /oauth/revoke` (RFC 7009)
- **MCP Server Card (SEP-2127)**: `GET /api/mcp/server-card` (`application/mcp-server-card+json`)
- **AI Catalog discovery**: `GET /.well-known/ai-catalog.json` (`application/ai-catalog+json`)

## Authentication

`/mcp` (and `/api/mcp`) supports **automatic MCP OAuth 2.1** out of the box as well as static Bearer API tokens:

### 1. Automatic OAuth 2.1 (Recommended for Claude, ChatGPT, Cursor, VS Code, MCPJam)

Simply add `https://jean-ci.example.com/mcp` as a remote MCP server with **no manual tokens or headers**:
- Unauthenticated requests receive `401` with an RFC 9728 `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource/mcp`.
- Clients automatically register via **Dynamic Client Registration (`/oauth/register`)** or **Client ID Metadata Documents (CIMD)** and start a PKCE `S256` flow at `/oauth/authorize`.
- Jean CI reuses your existing **GitHub OAuth** admin login (`ADMIN_GITHUB_ID`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) — no extra GitHub callback URL is needed.
- Access tokens expire after 1 hour with rotating 30-day refresh tokens, RFC 8707 audience binding, and `mcp:read` / `mcp:write` scope enforcement.

### 2. Static Bearer API Token (CI / Headless Scripts)

- Create a token in the Jean CI Admin UI (stored hashed in `jean_ci_api_tokens`), or configure `PUBLIC_API_TOKEN` / `PUBLIC_API_TOKENS`.
- Send `Authorization: Bearer <token>` on every request to `/mcp`.
- Cross-origin browser requests carrying an untrusted `Origin` header are rejected with `403 Forbidden` per MCP Streamable HTTP DNS-rebinding rules (same-origin `APP_BASE_URL`, loopback-to-loopback local dev, and optional comma-separated `MCP_ALLOWED_ORIGINS` are permitted; CLI/SDK clients without an `Origin` header are always allowed).

> **Security boundary**: Browser-session GitHub administrator controls for Hermes tool approvals (`POST /api/checks/{id}/approval` — **Approve once** / **Deny**) are intentionally **not** exposed over MCP (whether authenticated via OAuth 2.1 or static Bearer token). When a check is waiting on a tool approval, `get_review_check` returns a safe read-only indicator (`approvalStatus.waitingForApproval: true`) and the authenticated `/checks/<id>` URL for a human admin to open.

## Client Configuration

### Automatic OAuth (Claude, ChatGPT, Cursor, VS Code, Claude Code)

```json
{
  "mcpServers": {
    "jean-ci": {
      "type": "http",
      "url": "https://jean-ci.example.com/mcp"
    }
  }
}
```

### Static Bearer Token (Headless / CI)

```json
{
  "mcpServers": {
    "jean-ci": {
      "type": "http",
      "url": "https://jean-ci.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${JEAN_CI_API_TOKEN}"
      }
    }
  }
}
```

### MCPJam / MCP Inspector

```bash
npx -y @mcpjam/inspector@latest --url https://jean-ci.example.com/mcp
```

## Official MCP Extensions Enabled

| Extension | Identifier | How Jean CI uses it |
| --- | --- | --- |
| **MCP Apps** | `io.modelcontextprotocol/ui` | `get_pr_reviews` and `get_review_check` attach the interactive `ui://jean-ci/review-inspector.html` app view (verdict badges, findings summary, colorized diff preview, check prompt, refresh, and one-click retrigger). |
| **MCP Tasks** | `io.modelcontextprotocol/tasks` | Long-running `retrigger_pr_review` and `run_local_review` calls return a durable PostgreSQL-backed task handle (`resultType: "task"`) for tasks-capable clients to poll via `tasks/get` or cooperatively cancel via `tasks/cancel`. Non-tasks clients degrade gracefully. |
| **Skills over MCP** | `io.modelcontextprotocol/skills` | Publishes verified Agent Skills (`skill://jean-ci/triage-pr-review/SKILL.md` and `skill://jean-ci/author-pr-check/SKILL.md`) with SHA-256 manifests and directory reads (`skills/list`, `skills/get`, `resources/read`, `resources/directory/read`). |
| **MCP Events** | `io.modelcontextprotocol/events` (SEP-3415) | Emits `pr_review.completed`, `pr_review.check_completed`, and `pr_review.approval_required` events with minimal triage payloads over **Poll** (`events/poll`, cursor-resumable) and **Webhook** (`events/subscribe` / `events/unsubscribe`, Standard Webhooks HMAC-signed, SSRF-hardened pinned-DNS HTTPS, verification handshake, TTL renewal). |
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

## Resources & Prompts

- **Resources**: `jean-ci://stats`, `jean-ci://repos`, `jean-ci://prs/open`, `jean-ci://checks/{checkId}`, `jean-ci://repos/{owner}/{repo}/prs/{prNumber}/reviews`, `ui://jean-ci/review-inspector.html`, and `skill://jean-ci/...`.
- **Prompts**: `triage-pr-reviews`, `fix-review-findings`, `draft-pr-check-prompt` (with repository autocompletion).

## Google Antigravity Plugin

This repository ships an official **Google Antigravity plugin** at the repository root (`.antigravity-plugin/plugin.json` + `mcp_config.json` + `skills/` + `agents/` + `rules/` + `assets/logo.svg`).

```bash
# Install directly from GitHub
agy plugin install https://github.com/telegraphic-dev/jean-ci

# Or validate and install from a local checkout
agy plugin validate .
agy plugin install .
```

1. Enable the `jean-ci` plugin in **Customizations > Installed** (Antigravity App) or `/plugin` (Antigravity CLI).
2. Enter your `JEAN_CI_URL` base URL including `https://` without a trailing slash (for example, `https://jean-ci.telegraphic.app`).
3. Complete the automatic OAuth 2.1 browser sign-in flow (Antigravity discovers Jean CI via RFC 9728 / RFC 8414 and authenticates with CIMD or DCR + PKCE `S256`).

The plugin bundles:
- **MCP Server (`jean-ci`)**: Connects to `${JEAN_CI_URL}/mcp` with a 600s timeout and eagerly loaded `get_pr_reviews`, `get_review_check`, and `retrigger_pr_review` tools.
- **Skills**: `/triage-pr-review`, `/local-pr-review`, and `/author-pr-check`.
- **Subagent**: `jean-ci-reviewer` (read-only PR review triage specialist).
- **Rule**: `rules/jean-ci-pr-checks.md` (glob-triggered for `.jean-ci/pr-checks/*.md`).

