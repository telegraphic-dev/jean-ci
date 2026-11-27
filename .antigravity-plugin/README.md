# Jean CI for Google Antigravity

Connect Google Antigravity to your **Jean CI** server over the Model Context Protocol (MCP) to inspect, triage, locally validate, and retrigger automated pull request reviews, as well as monitor CI pipelines, Coolify deployments, webhook events, and scheduled tasks.

## Setup

1. **Install the plugin**
   ```bash
   agy plugin install https://github.com/telegraphic-dev/jean-ci
   ```
2. **Configure your Jean CI server URL**
   - Because this plugin supports self-hosted Jean CI instances via the `JEAN_CI_URL` variable, enable the plugin in **Customizations > Installed** (Antigravity App) or `/plugin` (Antigravity CLI) and enter your server base URL including `https://` and without a trailing slash (for example, `https://jean-ci.telegraphic.app`).
3. **Sign in with OAuth 2.1**
   - When Antigravity connects to `${JEAN_CI_URL}/mcp`, Jean CI automatically advertises RFC 9728 / RFC 8414 OAuth metadata with **Client ID Metadata Documents (CIMD)** and **Dynamic Client Registration (DCR)** plus PKCE (`S256`).
   - Complete the browser sign-in flow as an authorized Jean CI GitHub administrator. No manual OAuth client ID or static API token is required.

## Included Components

### MCP Server (`jean-ci`)
Connects to `${JEAN_CI_URL}/mcp` over Streamable HTTP (MCP `2026-07-28`) with a 10-minute tool timeout for long-running reviews:
- **Eagerly loaded core tools**: `get_pr_reviews`, `get_review_check`, `retrigger_pr_review`
- **Additional tools (lazy-loaded on demand)**: `list_open_prs`, `list_pr_reviews`, `override_pr_review`, `run_local_review`, `list_pr_check_definitions`, `get_ci_stats`, `list_repos`, `get_repo`, `list_pipelines`, `list_deployments`, `list_events`, `list_tasks`, `list_feature_sessions`
- **MCP Extensions**: Interactive MCP Apps (`ui://`), MCP Tasks for long-running reviews, Skills over MCP, and MCP Events (`pr_review.completed`, `pr_review.check_completed`, `pr_review.approval_required`).

### Skills
- `/triage-pr-review` — Inspect failing, stale, or approval-waiting PR review checks, fix confirmed findings, validate locally, and retrigger safely.
- `/local-pr-review` — Run Jean CI's `Code Review` and custom `.jean-ci/pr-checks/*.md` checks against your local `git diff` before pushing.
- `/author-pr-check` — Author, validate, and test repository-specific `.jean-ci/pr-checks/*.md` review rules.

### Custom Subagent
- `jean-ci-reviewer` — Read-only triage subagent that correlates failing Jean CI check findings against local repository code and returns a prioritized fix plan without modifying files.

### Rules
- `rules/jean-ci-pr-checks.md` — Automatically activates when editing `.jean-ci/pr-checks/*.md` files to enforce Jean CI's required prompt structure and verdict criteria.
