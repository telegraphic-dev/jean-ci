# API/OpenAPI Parity Check

## Purpose
Ensure Web API and OpenAPI stay in sync for public endpoints, with specific focus on repo-scoped views and filters introduced after PR #82.

## Review Instructions
Review this PR for API contract drift. Block the PR if any of these are true:
- A route/HTTP method exists in `app/api/public/v1/**/route.ts` but is missing from OpenAPI (`app/api/public/openapi.json/route.ts` via `lib/public-openapi.ts`).
- OpenAPI declares query/path params that handlers do not implement.
- Handlers support query/path params that OpenAPI does not declare.
- Repo-scoped surfaces (`/repos/{owner}/{repo}` and nested views) changed without matching OpenAPI updates.
- API behavior changed without updating parity coverage (especially `tests/public-openapi-parity.test.ts`).

Validation expectations:
- Run tests and confirm parity coverage passes.
- Confirm docs still list `/api/public/openapi.json`.

Required response format:
- First non-empty line must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.
- After the verdict, provide 2-5 concise bullets with concrete findings tied to changed files/behavior.

## Verdict Criteria
- PASS: API route surface, params, and behavior are consistent with OpenAPI for all changed public endpoints, and parity tests are updated/passing.
- FAIL: Any API/OpenAPI mismatch exists, repo-scoped parity is incomplete, or parity validation coverage is missing/stale.
