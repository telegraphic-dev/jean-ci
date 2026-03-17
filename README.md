# jean-ci

jean-ci is the OpenClaw review buddy for pull requests. It listens for GitHub events, runs human-readable review prompts through your OpenClaw gateway, and posts the results back as checks your team can act on.

It is built for teams that want useful review pressure without turning CI into a wall of noise.

## What it does

- Reviews every PR with a shared global prompt
- Runs repo-specific checks from `.jean-ci/pr-checks/*.md`
- Publishes findings as native GitHub Checks
- Lets admins tune prompts and repository access from the dashboard
- Can trigger Coolify restarts after GHCR publishes
- Can run natural-language browser checks through OpenClaw responses

## How the flow works

```text
Pull request opened
  -> GitHub webhook
  -> jean-ci
  -> OpenClaw Gateway
  -> LLM review pass
  -> GitHub Checks with findings
```

Think of jean-ci as a steady buddy sitting in your CI lane:

- One shared review standard for every repository
- Extra pearls of guidance per repository when a team needs them
- Clear pass/fail output instead of hidden side-channel logs

## Brand direction

This public docs refresh follows the ClawBuddy source of truth from `telegraphic-dev/openclaw-mentor`:

- Coral Orange: `#D16640`
- Dark Rust: `#874534`
- Cream: `#F9EACF`
- Warm-light surfaces, direct operator copy, and buddy / hatchling / pearls language

## Quick setup

### 1. Set the environment

```bash
# GitHub App
GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_APP_PRIVATE_KEY_B64=base64_encoded_private_key

# GitHub OAuth for /admin
GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret
ADMIN_GITHUB_ID=your_github_user_id

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=http://coolify-proxy/openclaw
OPENCLAW_GATEWAY_TOKEN=your_gateway_token

# Persistent storage
DATA_DIR=/data
```

### 2. Configure the GitHub App

Required permissions:

- `Checks`: Read & Write
- `Contents`: Read
- `Pull requests`: Read
- `Metadata`: Read

Subscribe to:

- `pull_request`
- `check_suite`
- `installation`

### 3. Add review prompts to a repo

Each markdown file in `.jean-ci/pr-checks/` becomes its own GitHub Check. Keep prompts plain, direct, and focused on what a human reviewer would care about.

```text
.jean-ci/
  pr-checks/
    security.md
    style.md
    tests.md
```

Example `security.md`:

```md
Review this pull request like a careful security engineer.

Look for:
- auth or permission bypasses
- unsafe input handling
- secret leakage
- SSRF, XSS, or injection paths
- missing validation on newly added endpoints

Return only concrete findings. Include file paths and line numbers when possible.
If there are no real findings, say "No material security findings."
```

Example `tests.md`:

```md
Review this change for test risk.

Call out:
- new behavior without coverage
- fragile assertions
- mocks that hide important regressions
- edge cases the PR now depends on

Be concise. Prefer a short list of actionable findings over a long essay.
```

## Admin dashboard

The admin UI at `/admin` lets you:

- edit the global review prompt
- enable or disable repositories
- inspect recent webhook activity

The goal is simple: human operators should be able to tighten or relax review behavior without redeploying the service.

## Coolify deploy hooks

jean-ci can restart Coolify apps when GitHub publishes a matching GHCR package.

Add `.jean-ci/coolify.yml` to the target repository:

```yaml
deployments:
  - package: ghcr.io/your-org/your-repo
    coolify_app: your-coolify-app-uuid
    environment: production
```

When jean-ci receives the `registry_package` webhook, it maps the package to `coolify_app` and calls Coolify's restart endpoint.

### Docker Compose notes

If your Coolify app uses the `dockercompose` build pack, point it at a prebuilt GHCR image and keep routing in the compose file:

```yaml
services:
  app:
    image: ghcr.io/your-org/your-repo:latest
    environment:
      - NODE_ENV=production
    volumes:
      - /host/path:/container/path
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

## Browser-based checks

If you want natural-language browser testing, enable OpenClaw responses:

```bash
OPENCLAW_USE_RESPONSES=true
```

That switches jean-ci from chat completions to the fuller responses path with tool use.

The gateway must expose the responses endpoint:

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

Example E2E prompt:

```md
## Test: Login flow

1. Open https://your-app.com
2. Click "Sign In"
3. Use test@example.com
4. Submit the form
5. Confirm "Welcome back" appears

VERDICT: PASS if the full flow works. FAIL otherwise.
```

## Development

```bash
npm install
npm run build
```

The public docs are intentionally written for operators first: plain language, copyable prompts, and enough structure to get jean-ci live quickly.
