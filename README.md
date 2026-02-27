# jean-ci

GitHub webhook handler that routes events to Jean (OpenClaw).

## Events Handled

- **pull_request** → Notifies on new/updated PRs
- **pull_request_review_comment** → Line comments for review
- **issue_comment** → `/review` command support
- **check_suite** → CI failure alerts
- **deployment_status** → Post-deploy verification triggers

## Environment Variables

```bash
# Required
GITHUB_APP_ID=
GITHUB_WEBHOOK_SECRET=

# Private key (one of these)
GITHUB_APP_PRIVATE_KEY=      # PEM content directly
GITHUB_APP_PRIVATE_KEY_PATH= # Or path to .pem file

# OpenClaw integration
OPENCLAW_GATEWAY_URL=
OPENCLAW_GATEWAY_TOKEN=
```

## Deployment

Deployed to Coolify at `jean-ci.telegraphic.app`.

## Local Testing

```bash
npm install
npm run dev
# Send test webhook to http://localhost:3000/webhook
```

## Gateway Connection

jean-ci connects to OpenClaw via the internal Traefik proxy:
- URL: `http://coolify-proxy/openclaw/v1/chat/completions`
- Auth: Bearer token in `OPENCLAW_GATEWAY_TOKEN`
