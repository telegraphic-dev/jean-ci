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

## Gateway Connection

Uses the Coolify Traefik proxy bridge:
- URL: `http://coolify-proxy/openclaw`
- Auth: Bearer token

See COOLIFY_INSTANCES.md for bridge setup details.
# Test 1772215693
