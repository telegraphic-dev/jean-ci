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

# Optional Coolify integration
COOLIFY_URL=https://coolify.example.com
COOLIFY_DASHBOARD_URL=https://coolify.example.com
COOLIFY_TOKEN=your_coolify_token
DEFAULT_DEPLOYMENT_DOMAIN=apps.example.com

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

## Coolify Auto-Deploy

jean-ci can automatically deploy to Coolify when new container images are published to GHCR.

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
# jean-ci deployment config
deployments:
  - provider: coolify
    package: ghcr.io/your-org/your-repo
    coolify_app: your-coolify-app-uuid
    environment: production
    no_op: true
```

Legacy format still supported:

```yaml
deployments:
  - package: ghcr.io/your-org/your-repo
    coolify_app: your-coolify-app-uuid
    environment: production
```

2. **Configure GitHub Actions** to build and push to GHCR on push to main.

3. **Install the jean-ci GitHub App** on your repository.

When a new image is published to GHCR, jean-ci receives the `registry_package` webhook and evaluates matching deployment entries.

### Deployment config behavior

- `provider` defaults to `coolify` when omitted (legacy compatibility)
- `no_op: true` marks the deployment as review-only; jean-ci reports intent but skips the provider API call
- multiple deployment entries are allowed
- only entries whose `package` matches the published GHCR package are considered

### How It Works

jean-ci is **buildpack-agnostic** — it doesn't know or care whether your Coolify app uses `dockerfile`, `dockerimage`, or `dockercompose`. It simply:

1. Receives `registry_package` webhook from GitHub
2. Matches the package URL to a `coolify_app` UUID in your deployment config
3. Calls `POST /applications/{uuid}/restart` on Coolify API unless `no_op: true`
4. Updates GitHub deployment state / logs accordingly

This means the **buildpack is configured in Coolify UI**, not in the jean-ci config. The repo config is just a mapping from GHCR package → deployment target plus policy.

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

Uses the Coolify Traefik proxy bridge:
- URL: `http://coolify-proxy/openclaw`
- Auth: Bearer token

See `docs/coolify-instances.md` for bridge setup details.

## Advanced: Browser-Based E2E Tests

jean-ci can run natural language E2E tests using OpenClaw's browser capabilities.

### Enable OpenResponses API

Set the environment variable to use the full agent codepath:

```bash
OPENCLAW_USE_RESPONSES=true
```

This switches from `/v1/chat/completions` (LLM only) to `/v1/responses` (full agent with tools).

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
