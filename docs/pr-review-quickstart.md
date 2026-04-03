# PR Reviews Quickstart

Goal: get your first automated PR review running in under 10 minutes.

## 1. Install and configure jean-ci

Follow the root `README.md` setup for:

- environment variables
- GitHub App permissions
- webhook delivery
- OpenClaw gateway access

Verification command:

```bash
curl -s http://localhost:3000/api/health
```

Expected result:

```json
{"ok":true}
```

## 2. Know what runs by default

As soon as PR review is enabled for a repo, jean-ci always runs the built-in `jean-ci / Code Review` check.

Files in `.jean-ci/pr-checks/*.md` are optional additive checks for repo-specific rules. They do not replace, hide, or disable the built-in review.

If jean-ci reuses an existing evaluation session while running a prompt, it must clear/reset that session before evaluating the new prompt.

## 3. Add a starter prompt for an extra repo-specific check

Create `.jean-ci/pr-checks/security.md` in the target repository:

```markdown
# Security Review

## Purpose
Catch blocking security regressions before merge.

## Review Instructions
Review the PR diff for:
- exposed secrets or credentials
- missing authorization checks
- unsafe input handling
- SSRF, XSS, SQL injection, or command injection risk
- unsafe deserialization or path traversal

Reference the changed code paths when you find a blocking issue.
Only fail for merge-blocking findings.

## Verdict Criteria
- **FAIL** when the diff introduces a real security vulnerability or exposes secrets.
- **PASS** when no blocking security issues are present in the diff.
```

Verification command:

```bash
git add .jean-ci/pr-checks/security.md && git commit -m "chore: add jean-ci security review"
```

## 4. Open or update a pull request

jean-ci runs on PR open, reopen, synchronize, `ready_for_review`, and explicit `/review` comments.

Verification command:

```bash
gh pr comment <pr-number> --body "/review"
```

## 5. Read the result

You should see:

- the always-on `jean-ci / Code Review` check
- one additional GitHub Check per prompt file
- a PR review comment for the built-in `Code Review`

If a custom repo prompt is malformed, that custom check fails fast with an actionable error instead of sending ambiguous output to the LLM. The built-in default review keeps running.

## Prompt schema

Each prompt should contain:

1. a title
2. `## Purpose`
3. `## Review Instructions`
4. `## Verdict Criteria`
5. explicit PASS and FAIL conditions

See also:

- `docs/prompt-library/security.md`
- `docs/prompt-library/tests-and-docs.md`
- `docs/prompt-library/migration-safety.md`
