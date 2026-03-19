Review any API changes for Web API ↔ OpenAPI parity.

Block this PR if any are true:
- A route/HTTP method exists in `app/api/public/v1/**/route.ts` but is missing from `app/api/public/openapi.json/route.ts` (via `lib/public-openapi.ts`).
- OpenAPI documents query/path params that the handler does not support, or handlers support params that OpenAPI does not declare.
- Repo-scoped API changes (`/repos/{owner}/{repo}` and nested views) are not reflected in OpenAPI.
- API behavior changed without updating tests that enforce parity (especially `tests/public-openapi-parity.test.ts`).

Validation expectations:
- Run tests and confirm parity coverage passes.
- Confirm docs still list the public API entrypoint (`/api/public/openapi.json`).

Context:
- This guardrail is a follow-up to parity work originally introduced in PR #82.
