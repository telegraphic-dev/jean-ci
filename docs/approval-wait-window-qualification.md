# Approval wait window qualification

## Native cause, not an assumed default

The read-only incident check for `telegraphic-dev/a2a-exposed-site` PR 171, check 4941, confirmed three completed native segments. Only segment 3 (`run_1d0ae77d080249d19c817a3f77d6f3c2`) had `denied=true`; all pending arrays were empty.

Its exact native tool transcript records a blocked terminal result at **2026-10-22T19:46:23.140211Z**, with the native user summary **“No answer within 1 minute — the command did not run.”** This is evidence of the actual one-minute approval expiry, not a deduction from Hermes's current 300-second config default. The check completed at 19:46:34.697Z, 70.697 seconds after the reported 19:45:24Z notification. The nine-minute app deadline could also consume human waiting time, but was not the demonstrated expiry cause for this incident. No command text or credentials are retained here.

The installed source at `e6f57427c198cfd96854522b7a9159eb007e13c2` reads `approvals.timeout` in `tools/approval_context.py`; its native blocking waiter reads that value, and canonical API controls project the same waiter. The installed Runs request has no safe per-run timeout field. The authoritative API documentation was checked at <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server> before defining an additive extension.

## Coordinated prerequisite

The isolated native extension is committed at **`625b7bdd35ff9bf29dc797c24bd051909d957c3a`**, branch `fix/api-run-approval-window`, in `/home/openclaw/worktrees/hermes-approval-wait-window`. It is based on the installed source above, not edited into the shared runtime.

It adds `features.run_approval_timeout_v1` and a validated fresh-Runs `approval_timeout_s` field, bounded to 1–1800 seconds. The value is durable per admission, is part of exact retry identity, is not saved as a session default, and does not change approval policy. Pending controls expose a stable native deadline; late exact approvals fail closed. Existing unscoped approval timing and session/always semantics are unchanged. Continuations and room grants cannot acquire this override.

**Deployment order:** independently review/install the native extension first; confirm this capability from the exact reviewer base/profile/credential route; then deploy the app. No global/default/Jean approval configuration should be changed. An older gateway is a hard prerequisite failure for new Runs reviews, not an app-only 30-minute promise. Already completed incident executions cannot be revived. Unknown/unreachable native executions remain fail-closed rather than being silently recreated.

Startup app migrations add safe history and the durable restart mapping/queue. Existing run bindings, the cross-process observation lock, exact decision identities, and the 60-second database-clock decision lease remain in force. Explicit restart creates one new check, verifies current open PR/head/enabled repository and known-terminal native executions, and still requires separate approval. Queued requests survive dispatch interruption; claimed executions are never automatically replayed. Full multi-segment worker continuation after a process crash is not provided.

## Verification boundaries

- All app unit tests and production build are exercised; the build includes `/api/checks/[id]/restart`. Standalone whole-tree `tsc --noEmit` also reports unrelated test-fixture typing errors in unchanged `openclaw-playground`, `openclaw-status`, `public-openapi-parity`, and `repo-feature-sessions` tests; this handoff does not claim that separate baseline check is green.
- The PostgreSQL integration suite drives the real PR runner/controller, concurrent observations and decision dispatch, lease expiry, denial/expiry, notification failures, durable restart deduplication (12 clicks and 8 dispatchers), changed head, closed/disabled PR, live/unknown original execution and replay rejection. Hermes/GitHub boundaries in this suite are fixtures.
- The separate **cross-language native integration** uses the real app PR runner and PostgreSQL against the committed native HTTP API, SQLite authority and blocking approval waiter. Only GitHub and the LLM are fixtures. It proves a negotiated 1800-second deadline, concurrent polls without consent, once resuming the same live run, deny, native rejection of an exact approval after simulated monotonic expiry, incomplete results despite optimistic reviewer text, and replay refusal. The isolated fixture owns its HOME, state DB and child process and removes them. The expiry race advances only the disposable waiter's clock; it does not claim a thirty-minute wall-clock soak.
- Native API/approval regression: **108 files, 890 passed, 1 macOS-only skip** through the canonical `scripts/run_tests.sh`. The new native HTTP test also lets a one-second waiter expire naturally while a simultaneous 1800-second waiter remains actionable, then resumes that exact live waiter.
- Built Next HTTP tests use local sealed administrator/foreign cookies and a strong task-local secret. They exercise actual approval/restart handlers, origin/type/body-size guards, default-secret/unset-admin refusal, completed-check history and retained panel rendering. Test server environments do not inherit live credentials. This is cookie/authorization coverage, not live GitHub OAuth-provider coverage.
- A real browser loaded the authenticated completed-check fixture and rendered **Approval expired**, its deadline, **Restart review**, and no Approve-once action. No private expired command appeared in that completed view.

No live approval, PR comment, retry, push, deployment, gateway restart, shared runtime source edit or runtime configuration change was performed.

## Repeatable local checks

Use a disposable loopback PostgreSQL database with a name beginning `jean_approval_test` (the suites deliberately reset fixture checks), and a native test interpreter with the committed checkout's dependencies:

```bash
npm test
npm run build
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:integration
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test \
  HERMES_APPROVAL_NATIVE_SOURCE=/path/to/isolated/native/checkout \
  HERMES_APPROVAL_NATIVE_PYTHON=/path/to/native/test/python \
  npm run test:approvals:native
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:http
```
