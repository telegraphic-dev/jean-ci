## Post-Deployment Health Check

Verify jean-ci is healthy after deployment.

### Steps:

1. Use `exec` to check the health endpoint:
```bash
curl -s {{APP_URL}}/api/health
```

2. Use `exec` to take a screenshot of the homepage:
```bash
npx playwright screenshot --browser chromium '{{APP_URL}}' /tmp/jean-ci-smoke.png
```

3. Verify the health endpoint returns a valid response

### Verdict:
- **VERDICT: PASS** if health endpoint responds AND screenshot succeeds
- **VERDICT: FAIL** if either check fails
