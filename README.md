# jean-ci

GitHub webhook handler for automated PR reviews with LLM assistance.

## Features

- **Automated PR Reviews**: Run LLM-powered code reviews on every PR
- **Customizable Prompts**: Edit the global review prompt in the admin UI
- **Per-Repo Checks**: Add `.jean-ci/pr-checks/*.md` files for custom checks
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

## Setup

### 1. Environment Variables

```bash
# GitHub App
GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_APP_PRIVATE_KEY_B64=base64_encoded_private_key

# GitHub OAuth (for admin UI)
GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret

# Admin access (your GitHub user ID)
ADMIN_GITHUB_ID=your_github_user_id

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=http://coolify-proxy/openclaw
OPENCLAW_GATEWAY_TOKEN=your_gateway_token

# Data storage
DATA_DIR=/data
```

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

1. **Add `.jean-ci/coolify.yml`** to your repository:

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

Uses the Coolify Traefik proxy bridge:
- URL: `http://coolify-proxy/openclaw`
- Auth: Bearer token

See COOLIFY_INSTANCES.md for bridge setup details.
# Test 1772215693
# Test 1772215887
# Test 1772216099

