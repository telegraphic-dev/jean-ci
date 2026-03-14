# Security Review

## Purpose
Catch merge-blocking security regressions in the PR diff.

## Review Instructions
Check the changed code for:
- exposed secrets or credentials
- missing authz/authn checks
- unsafe input handling
- XSS, SSRF, SQL injection, command injection, path traversal
- unsafe deserialization or insecure redirects

Call out only blocking issues. Reference the relevant code path or file when possible.

## Verdict Criteria
- **FAIL** if the diff introduces a real security vulnerability or exposes a secret.
- **PASS** if no blocking security issues are present in the diff.
