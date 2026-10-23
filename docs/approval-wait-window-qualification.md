# Approval wait window qualification

## Native cause and approved configuration

The read-only incident check for `telegraphic-dev/a2a-exposed-site` PR 171, check 4941, confirmed three completed native segments. Only segment 3 (`run_1d0ae77d080249d19c817a3f77d6f3c2`) had `denied=true`; all pending arrays were empty. Its native transcript recorded “No answer within 1 minute — the command did not run” at 2026-10-22T19:46:23.140211Z. This establishes the actual short native timeout; a longer app deadline alone cannot fix it.

The installed **unmodified** Hermes baseline is `e6f57427c198cfd96854522b7a9159eb007e13c2`. Its blocking waiter reads `approvals.timeout` in `tools/approval_context.py`; canonical Runs controls use that same waiter. No upstream extension is required. New app submissions contain only `input` and `instructions`, with the existing durable Idempotency-Key header. Decisions contain only exact native `request_id`, `execution_generation`, and `choice: once|deny`. The canonical authority response uses `status: resolved`; the app then reads back the same run before recording accepted consent.

The user explicitly approved and the parent operator applied:

```bash
hermes --profile jean config set approvals.timeout 1800
```

This affects **all Jean-profile approvals**, not only jean-ci reviews. It does **not** modify the default profile and does not enable bypass, session-wide consent, or permanent approval. No test writes either shared configuration. Serving processes must load this configuration before the app is enabled; no gateway restart or deployment is part of this change. Existing expired incident executions cannot be revived. Native upstream PR 143230 is not a prerequisite and is left unchanged.

## Honest baseline deadline and budget

Baseline pending controls can omit both `timeout_s` and `expires_at`. The app persists first-observed time and a bounded calculated deadline under the existing PostgreSQL observation row lock. It uses native `timeout_s` when available, otherwise the configured 1800-second bound; no calculated wait exceeds 30 minutes per prompt/generation. The UI labels that deadline **approximate**, including history, and explicitly warns native expiry may be earlier. The app never invents a native `expires_at` or promises its estimate overrides the native waiter. Refresh, concurrent polling, database reload, or reappearance of an old exact prompt cannot renew the recorded window.

The nine-minute active-execution budget excludes canonical approval waiting only up to that bounded deadline. A simulated twenty-minute human wait is tested with and without native timeout metadata, followed by successful completion or active-work timeout. A stuck canonical wait cannot pause the app indefinitely. This is not a thirty-minute wall-clock soak.

The baseline uses native first-settlement arbitration, not the extension's entry-deadline semantics. Qualification advances the disposable waiter's monotonic clock, waits for actual native timeout and queue removal, and then submits the old exact once over HTTP. It is refused without resurrecting the run. This does not claim an unmodified baseline atomically rejects a once that races ahead of timeout settlement solely because a wall-clock estimate has elapsed.

## Security and restart durability retained

Existing same-run bindings, exact prompt/generation controls, requester/profile scope, admin/CSRF guards, cross-process observation locking, ambiguous-delivery refusal, and the 60-second database-clock decision lease remain. Denial, expiry or unconfirmed consent cannot turn optimistic reviewer text into a complete PASS. Completed checks show safe approval history without private command/arguments and cannot accept old approvals. Explicit restart verifies known-terminal native executions, current open PR/head and enabled repository, deduplicates source-check reservations, and still requires new consent.

Restart claims return the reserved check in the same SQL statement that claims it. Startup atomically settles pre-startup dispatching reservations and marks unfinished checks INCOMPLETE/failure, including before GitHub ID persistence. Failed settlement rolls back and is recoverable at next startup. Queued requests, fresh claims, completed results and permanent source deduplication remain intact. Claimed uncertain external work is never automatically replayed. An externally created check whose ID was not persisted can remain orphaned; local settlement does not promise external check synchronization. Full crash-resumable multi-segment execution is not provided.

## Verification boundaries

- Recorded app results for this revision: **190 unit tests passed, 1 skipped; 11 PostgreSQL integration tests passed; 1 cross-language native integration passed; 1 built-app HTTP integration passed; production build passed**. `git diff --check` passed.
- Full app unit suite, production Next build, and built-app HTTP approval/restart handlers are exercised. HTTP tests use task-local sealed cookies and no live credentials; this is authorization coverage, not real GitHub OAuth-provider coverage.
- PostgreSQL integration retains all ten existing tests, including process-death crash settlement, claim/settlement rollback, concurrency, restart deduplication and no duplicate external creation. An additional regression proves durable approximate deadlines survive reload and cannot renew after canonical settlement. Hermes and GitHub are fixtures in this suite.
- The cross-language integration pins the unmodified installed baseline above and rejects another HEAD or modified tracked Python source. It runs the real app PR runner/PostgreSQL against real native HTTP, SQLite authority and blocking waiter; only the LLM and GitHub are fixtures. The task-local HOME/config sets `approvals.timeout: 1800`, and the fixture asserts the native config reader returns 1800. Once resumes the exact run; deny and actual native expiry remain incomplete; replay and late HTTP once are refused. Clock acceleration is only a disposable fixture seam, not modified native source. Native launcher lazy installs and Python bytecode writes are disabled in the test child.
- The tests own and remove their native HOME/process. Use a separately owned disposable PostgreSQL container/database and retire that exact resource after qualification. Never reuse or stop another task's database.

No PR push, live approval/comment, deployment, gateway restart, native source modification, default-profile change, or upstream PR change is performed by this revision. The profile-wide operator change above is intentional and separately approved.

## Repeatable local checks

Use a disposable loopback PostgreSQL database named with prefix `jean_approval_test`:

```bash
npm ci --no-audit --no-fund
npm test
npm run build
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:integration
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test \
  HERMES_APPROVAL_NATIVE_SOURCE=/home/openclaw/.hermes/hermes-agent \
  HERMES_APPROVAL_NATIVE_PYTHON=/path/to/native/dependency/python \
  npm run test:approvals:native
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:http
```
