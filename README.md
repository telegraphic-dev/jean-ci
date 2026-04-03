# jean-ci

GitHub webhook handler for automated PR reviews with LLM assistance.

## Features

> OSS readiness is tracked in `docs/oss-readiness.md` (private-first rollout).

- **Automated PR Reviews**: Run the built-in `Code Review` on every PR
- **Customizable Default Review**: Edit the always-on default review prompt in the admin UI
- **Additive Per-Repo Checks**: Add `.jean-ci/pr-checks/*.md` files for extra checks without replacing the default review
- **GitHub Checks Integration**: Results appear as nested checks on PRs
- **Admin Dashboard**: GitHub OAuth protected management interface

## Architecture

```
PR Opened → Webhook → jean-ci → OpenClaw Gateway → LLM
                         ↓
                  GitHub Checks API
                         ↓
                  ✅ Global Standards
                  ✅ security.md
                  ✅ style.md
```

## PR Reviews Quickstart

1. Copy `.env.example` to `.env` and set the GitHub App + OpenClaw gateway values.
2. Install the GitHub App with **Checks**, **Contents**, **Pull requests**, and **Metadata** permissions.
3. Optional: add one or more structured prompt files under `.jean-ci/pr-checks/*.md` for repo-specific checks.
4. Open or update a pull request, or comment `/review` on an existing PR.

Minimal starter prompt:

```markdown
# Security Review

## Purpose
Catch blocking security regressions before merge.

## Review Instructions
Review the PR diff for exposed secrets, missing authorization checks, unsafe input handling, and injection risks.
Only fail for merge-blocking findings.

## Verdict Criteria
- **FAIL** if the diff introduces a real security vulnerability or exposes secrets.
- **PASS** if no blocking security issues are present in the diff.
```

Important behavior:
- `jean-ci / Code Review` is always created and always runs when PR review is enabled.
- `.jean-ci/pr-checks/*.md` adds extra checks; it does not disable or replace the built-in review.
- Fast prompt validation applies to custom repo checks. Existing admin-configured default review prompts keep running, so upgrades do not break the built-in review path.

Prompt requirements for custom checks:
- title
- `## Purpose`
- `## Review Instructions`
- `## Verdict Criteria`
- explicit `PASS` and `FAIL` conditions

Starter prompt library:
- `docs/prompt-library/security.md`
- `docs/prompt-library/tests-and-docs.md`
- `docs/prompt-library/migration-safety.md`

Full walkthrough: `docs/pr-review-quickstart.md`

## Container release channels

- `ghcr.io/telegraphic-dev/jean-ci:dev` → published from every push to `main`
- semver tags (`vX.Y.Z`) publish stable images and update `latest`
- release pipeline also publishes SBOM, provenance, and cosign signatures

See `docs/release-engineering.md` for the release flow and runbook.

## Setup

### Easy local setup (Docker Compose)

```bash
make bootstrap
# edit .env and replace the required GitHub/OpenClaw placeholders
make doctor
docker compose up -d --build
```

This starts:
- `app` on `http://localhost:3000`
- `postgres` as an internal Compose service (not published on the host by default)

If you are upgrading an existing deployment, run the manual override migration before starting a build that expects the new columns:

```bash
psql "$DATABASE_URL" -f scripts/migrate-add-manual-review-override-columns.sql
```

Helpful commands:
- `make bootstrap` — create `.env`, generate local secrets, and sync a URL-encoded `DATABASE_URL` from `POSTGRES_*` values
- `make doctor` — check Docker/Compose and fail until required GitHub/OpenClaw values are replaced with real values
- `make up` / `make down` / `make logs`

The stock easy-setup flow is bash + Docker Compose only. No Python dependency is required.

What `make bootstrap` does **not** do:
- it does **not** invent fake GitHub App credentials for you
- it does **not** invent a real OpenClaw gateway token
- therefore `make doctor` will still fail until you replace those placeholders in `.env`

### 1. Environment Variables

Start from the template:

```bash
cp .env.example .env
```

Then set values:

```bash
# GitHub App
GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your_webhook_secret
# Default Docker Compose setup expects the private key inline as base64.
GITHUB_APP_PRIVATE_KEY_B64=base64_encoded_private_key

# GitHub OAuth (for admin UI)
GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret

# Admin access (your GitHub user ID)
ADMIN_GITHUB_ID=your_github_user_id

# Public app URL (used for GitHub links / webhook forwarding)
BASE_URL=https://jean-ci.example.com
NEXT_PUBLIC_BASE_URL=https://jean-ci.example.com

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=https://openclaw.example.com
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
# Optional but recommended: use a dedicated jean-ci operator/device token,
# not a personal token. If the gateway returns pairing/token-drift auth details,
# jean-ci now surfaces actionable recovery guidance in logs/errors.

# Optional Coolify integration
COOLIFY_URL=https://coolify.example.com
COOLIFY_DASHBOARD_URL=https://coolify.example.com
COOLIFY_TOKEN=your_coolify_token
DEFAULT_DEPLOYMENT_DOMAIN=apps.example.com

# Optional Paperclip integration (mark linked issues done when PRs merge)
PAPERCLIP_API_URL=https://paperclip.example.com
PAPERCLIP_API_KEY=your_paperclip_api_key

# Data storage
DATA_DIR=/data
```

If you want to load the GitHub App private key from a file path instead of base64:
- that is supported for non-Compose/manual deployments
- the default `docker-compose.yml` does **not** mount a host key file into the container
- for the stock easy-setup flow, use `GITHUB_APP_PRIVATE_KEY_B64`

### 2. GitHub App Permissions

Required permissions:
- **Checks**: Read & Write
- **Contents**: Read (for fetching `.jean-ci/` files)
- **Pull requests**: Read
- **Metadata**: Read

Subscribe to events:
- `pull_request`
- `check_suite`
- `installation`

### 3. Custom PR Checks

Add markdown files to `.jean-ci/pr-checks/` in your repository:

```
.jean-ci/
  pr-checks/
    security.md    # Security review prompt
    style.md       # Code style review prompt
    tests.md       # Test coverage review prompt
```

Each file becomes a separate GitHub Check with its own ✅/❌ status.

Example `security.md`:
```markdown
Review this PR for security issues:

- SQL injection vulnerabilities
- XSS attacks
- Exposed secrets or credentials
- Unsafe deserialization
- Missing input validation

Report any findings with specific line numbers.
```

## Admin Dashboard

Access at `/admin` after signing in with GitHub.

Features:
- Edit global PR review prompt
- Enable/disable PR reviews per repository
- View recent webhook events

## Public REST API

jean-ci now exposes a token-protected public API so external services can read operational data without direct database access.

- OpenAPI spec: `/api/public/openapi.json`
- Versioned endpoints: `/api/public/v1/*`
- Auth: `Authorization: Bearer <token>`

### Public endpoints

- `GET /api/public/openapi.json`
- `GET /api/public/v1/health`
- `GET /api/public/v1/stats`
- `GET /api/public/v1/repos`
- `GET /api/public/v1/checks?page=1&limit=50&repo=owner/repo`
- `GET /api/public/v1/pipelines?page=1&limit=20&repo=owner/repo`
- `GET /api/public/v1/events?page=1&limit=50&eventType=workflow_run&repo=owner/repo`
- `GET /api/public/v1/tasks?view=summary`
- `GET /api/public/v1/tasks?view=events&page=1&limit=50&repo=owner/repo&task=nightly`
- `GET /api/public/v1/repos/{owner}/{repo}`
- `GET /api/public/v1/repos/{owner}/{repo}/counts`
- `GET /api/public/v1/repos/{owner}/{repo}/checks?page=1&limit=50`
- `GET /api/public/v1/repos/{owner}/{repo}/pipelines?page=1&limit=20`
- `GET /api/public/v1/repos/{owner}/{repo}/events?page=1&limit=50`
- `GET /api/public/v1/repos/{owner}/{repo}/deployments?page=1&limit=50`

### Token management

Admin-authenticated API token management endpoints:

- `GET /api/tokens` list issued tokens (hashed at rest; token value is not returned)
- `POST /api/tokens` create a token (plain token is returned once)
- `DELETE /api/tokens/{id}` revoke a token

Optional bootstrap token(s) can be set via env vars:

- `PUBLIC_API_TOKEN`
- `PUBLIC_API_TOKENS` (comma-separated)

## Coolify Auto-Deploy

jean-ci can automatically deploy to Coolify when new container images are published to GHCR.

## Paperclip PR Sync

If `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` are set, jean-ci also watches merged GitHub pull requests and marks linked Paperclip issues as `done`.

Supported link formats inside the PR body/title/branch name:
- `https://paperclip.../issues/<issue-uuid>`
- `Paperclip issue: <issue-uuid>`
- `<!-- paperclip-issue-id:<issue-uuid> -->`

When a PR is closed without merging, no Paperclip update is sent.

### Setup

1. **Add a deployment config** to your repository.

Preferred new format: `.jean-ci/deployments.yml`

```yaml
# jean-ci deployment config
deployments:
  - provider: coolify
    package: ghcr.io/your-org/your-repo
    coolify_app: your-coolify-app-uuid
    environment: production
```

Review-only / no-op mode:

```yaml
deployments:
  - provider: noop
    package: ghcr.io/your-org/your-repo
    environment: review-only
```

Legacy `.jean-ci/coolify.yml` is still supported for compatibility:

```yaml
# jean-ci Coolify Deployment Config
deployments:
  - package: ghcr.io/your-org/your-repo
    coolify_app: your-coolify-app-uuid
    environment: production
```

2. **Configure GitHub Actions** to build and push to GHCR on push to main.

3. **Install the jean-ci GitHub App** on your repository.

When a new image is published to GHCR, jean-ci receives the `registry_package` webhook and triggers a Coolify deployment.

### How It Works

jean-ci is **buildpack-agnostic** — it doesn't know or care whether your Coolify app uses `dockerfile`, `dockerimage`, or `dockercompose`. It simply:

1. Receives `registry_package` webhook from GitHub
2. Matches the package URL to a `coolify_app` UUID in your `.jean-ci/coolify.yml`
3. Calls `POST /applications/{uuid}/restart` on Coolify API
4. Coolify handles the rest based on its own app configuration

This means the **buildpack is configured in Coolify UI**, not in `coolify.yml`. The `coolify.yml` is just a mapping from GHCR package → Coolify app UUID.

### Docker Compose Support

For apps that need volumes or custom networking, use Coolify's `dockercompose` buildpack:

1. **Set build_pack to `dockercompose`** in Coolify UI

2. **Add `docker-compose.yml`** to your repo:

```yaml
services:
  app:
    image: ghcr.io/your-org/your-repo:latest  # Use pre-built GHCR image
    environment:
      - NODE_ENV=production
    volumes:
      - /host/path:/container/path  # Volumes work!
    restart: unless-stopped
    networks:
      - coolify
    labels:
      - traefik.enable=true
      - traefik.http.routers.your-app.rule=Host(`your-app.example.com`)
      - traefik.http.routers.your-app.entrypoints=https
      - traefik.http.routers.your-app.tls=true
      - traefik.http.routers.your-app.tls.certresolver=letsencrypt
      - traefik.http.services.your-app.loadbalancer.server.port=3000

networks:
  coolify:
    external: true
```

Key points:
- Use `image:` with GHCR URL (not `build:`) - GitHub Actions builds, not Coolify
- Add Traefik labels for routing (dockercompose doesn't auto-add them)
- Join the `coolify` external network for Traefik discovery
- Volumes defined here actually work (unlike `custom_docker_run_options`)

## Gateway Connection

The OpenClaw gateway URL is deployment-specific. Configure it explicitly:
- URL: `OPENCLAW_GATEWAY_URL=https://openclaw.example.com`
- Auth: Bearer token via `OPENCLAW_GATEWAY_TOKEN`
- Recommendation: mint a dedicated jean-ci token/device identity instead of reusing a human operator token

If you're running behind a reverse proxy or bridge, point `OPENCLAW_GATEWAY_URL` at that endpoint.

### Gateway auth recovery

Current jean-ci uses HTTP calls to `/v1/chat/completions` or `/v1/responses`, and websocket RPC for exported gateway methods like `chat.send` / `sessions.list`.
True device pairing still happens on the gateway/device-auth side.

What jean-ci does now:
- keeps the existing HTTP integration intact
- parses structured gateway auth recovery details when they are returned
- surfaces actionable guidance for cases like:
  - `AUTH_TOKEN_MISMATCH`
  - `AUTH_DEVICE_TOKEN_MISMATCH`
  - `PAIRING_REQUIRED`

Recommended operational flow:
1. Give jean-ci its own stable identity/token instead of a personal token
2. Approve or rotate that device/token on the gateway when needed
3. Keep `OPENCLAW_GATEWAY_TOKEN` pointed at the dedicated jean-ci credential

Useful commands:
- `openclaw devices list`
- `openclaw devices approve <requestId>`
- `openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write --scope operator.admin`

### Pairing required: what to do

If jean-ci logs or PR checks show `PAIRING_REQUIRED`, the gateway is rejecting the websocket connect until this jean-ci device is explicitly approved.

Recommended recovery flow:
1. Run `openclaw devices list`
2. Find the pending jean-ci device request and note both the request id and device id
3. Approve it with `openclaw devices approve <requestId>`
4. Run `openclaw devices list` again and verify the device is now approved
5. Re-run the failed jean-ci check/job

If approval does not fix it, rotate the credential for that device:
- `openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write --scope operator.admin`

Admin UI helpers:
- Dashboard now shows the scopes jean-ci requests for its gateway device token.
- You can revoke the cached stored device token from the admin dashboard.
- After revocation, trigger any gateway action (for example from the gateway playground) and jean-ci will request a fresh token that includes `operator.admin`.

Operational note:
- jean-ci should use its own dedicated gateway identity/device, not a personal human operator token
- if the gateway returns a specific device id in the error details, surface it directly in logs/errors to make approval faster

## Using doubleagent for local GitHub testing

Repo: <https://github.com/islo-labs/doubleagent>

`doubleagent` can be useful for **partial local testing** of jean-ci, especially when you want fast PR/webhook iteration without hitting the real GitHub API.

What it is good for:
- fake repositories
- fake pull requests
- fake webhook delivery
- fast local iteration without rate limits or cleanup pain

What it is **not** enough for today:
- GitHub App installation/auth flows
- GitHub Checks / check runs
- GitHub Deployments API flows
- package / registry-driven deployment events

Practical recommendation:
- use `doubleagent` for PR + webhook testing
- use real GitHub for checks, deployments, and GitHub App behavior

In other words: it is a good **partial test harness**, not a full replacement for end-to-end jean-ci integration testing.

## Advanced: Browser-Based E2E Tests

jean-ci can run natural language E2E tests using OpenClaw's browser capabilities.

### Enable OpenResponses API

Set the environment variable to use the full agent codepath:

```bash
OPENCLAW_USE_RESPONSES=true
```

This switches the HTTP path from `/v1/chat/completions` (LLM only) to `/v1/responses` (full agent with tools).
It does not imply a websocket RPC method named `responses.create`.

**Requires:** The Gateway must have responses endpoint enabled:
```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "responses": { "enabled": true }
      }
    }
  }
}
```

### Writing E2E Tests

Create `.jean-ci/pr-checks/e2e-*.md` files with natural language test instructions:

```markdown
## Test: Login Flow

1. Open https://your-app.com in the browser
2. Click "Sign In"
3. Enter test@example.com as email
4. Submit the form
5. Verify "Welcome back" appears on the dashboard

VERDICT: PASS if all steps succeed, FAIL otherwise.
```

The agent will:
- Use browser automation to execute each step
- Take screenshots on failure
- Report PASS/FAIL based on results

### Using Playwright CLI

For reliable browser automation, instruct the agent to use Playwright CLI via exec:

```markdown
## Test: Verify Dashboard Loads

Use the `exec` tool to run Playwright commands:

```bash
npx playwright screenshot --browser chromium 'https://your-app.com' /tmp/screenshot.png
```

### Steps:
1. Run the Playwright screenshot command above
2. Verify the command succeeds (exit code 0)
3. Optionally fetch the page with web_fetch to verify content

VERDICT: PASS if screenshot succeeds, FAIL otherwise.
```

This approach:
- Works reliably without browser service configuration
- Uses Playwright's built-in Chromium
- Supports screenshots, PDFs, and page content verification

## Post-Deployment Smoke Tests

jean-ci can run smoke tests automatically after successful Coolify deployments.

### Setup

Add markdown files to `.jean-ci/smoke-tests/` in your repository:

```
.jean-ci/
  pr-checks/         # Run on PRs (before merge)
  smoke-tests/       # Run after deployment
    health.md        # Basic health check
    e2e-login.md     # Login flow test
    api-check.md     # API endpoint verification
```

### How It Works

```
Coolify Deploy Success → Webhook → jean-ci:
  1. Fetch .jean-ci/smoke-tests/*.md
  2. Run each test via OpenResponses API
  3. Report results as GitHub Check on commit
```

### Example Smoke Test

`.jean-ci/smoke-tests/health.md`:
```markdown
## Post-Deployment Health Check

Verify the deployed application is healthy.

### Steps:
1. Fetch {{APP_URL}}/api/health with web_fetch
2. Verify response contains "ok" or "healthy"
3. Use exec to run: `curl -s {{APP_URL}}/api/health | jq .status`

### Verdict:
- VERDICT: PASS if health endpoint returns success
- VERDICT: FAIL if endpoint is unreachable or returns error
```

### Available Variables

Variables in smoke test prompts are automatically replaced:

| Variable | Description |
|----------|-------------|
| `{{APP_URL}}` | Deployed application URL |
| `{{OWNER}}` | Repository owner |
| `{{REPO}}` | Repository name |
| `{{SHA}}` | Deployed commit SHA |

### Viewing Results

Smoke test results appear as GitHub Checks on the deployed commit:
- `jean-ci / smoke-test: health` ✅
- `jean-ci / smoke-test: e2e-login` ❌

Click through to see detailed output and failure reasons
