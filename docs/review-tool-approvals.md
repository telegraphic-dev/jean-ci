# Tool approvals during PR reviews

When Hermes needs approval to inspect required surrounding code or run a tool, the GitHub check stays **in progress**. jean-ci posts a PR comment linking directly to that review's **`/checks/[id]` detail page**. Sign in as the configured administrator to inspect the exact command/reason (and edit payload, if present), then choose **Approve once** or **Deny**. No decision is automatic; there is no session-wide or permanent approval action.

The page polls canonical Hermes run status. Before dispatching a decision the server checks the PR's current head, the active check's durable run binding, the current prompt ID and execution generation, and the native choices. The approval goes to the **same run**, not a new review. Expired, settled, superseded, terminal, cross-check and replayed requests are refused. Native expiry remains authoritative (commonly 60 seconds); refreshing the page does not extend it. Settled requests disappear from the action panel. A denied, observed expired, or unconfirmed request makes the execution incomplete rather than a complete PASS; earlier concrete blocking findings are retained. A tool wait alone never produces a `REQUEST_CHANGES` review.

## Configuration

- Keep the existing `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`. Use a dedicated reviewer requester. For Hermes profile routing, include the actual `/p/<profile>` prefix in the base URL if needed; all operations preserve that same base URL and bearer credential. There is no custom profile header.
- With HTTP transport (`OPENCLAW_USE_WEBSOCKET=false`), jean-ci selects Runs automatically when authenticated `GET /v1/capabilities` advertises `run_submission`, `run_status`, `run_approval_response`, and `approval_events`. Canonical `pending_controls` with `prompt_id` and `execution_generation` are required to display actionable approvals. No hidden runtime approval configuration is needed.
- Set `OPENCLAW_USE_RUNS=true` to require this transport and fail closed when unavailable. Set it to `false` only for a deliberately selected legacy HTTP integration. Existing OpenClaw WebSocket mode remains a separate legacy transport; it does not acquire this approval UI. Non-Hermes servers returning 404 for capabilities, or not advertising Runs, keep their legacy HTTP path. Authentication/discovery failures do not silently fall back.
- Configure `ADMIN_GITHUB_ID`, a non-default `SESSION_SECRET` of at least 32 characters, GitHub OAuth, and the exact externally visible `BASE_URL`. Missing admin configuration or the known default session key disables the controls even if an otherwise valid login cookie exists. POST requests must use that exact origin and JSON.
- The GitHub App needs **Pull requests: read/write** for review and approval-link comments (or Issues write for issue comments in addition to the review permissions). Existing installation credentials select the server-bound repository and PR; no client can supply a GitHub destination.
- Optional: `REVIEW_APPROVAL_DISCORD_WEBHOOK_URL` may point to an operator-configured HTTPS Discord webhook. Without it **no Discord message is sent**. Notifications contain only the authenticated detail-page link and a safe repository/SHA, never the tool command or arguments. Mentions are disabled. The destination cannot come from a PR or repository prompt.

PR approval-link comments contain only the check-page link, reviewed SHA, and approval-needed status, not tool data. Each check/run/generation/prompt gets its own durable delivery identity. Poll ticks do not post duplicates. The exact created comment is fetched back before its ID/URL is marked delivered. Definite HTTP refusals can retry after the delivery lease; a lost create acknowledgment is reconciled against this app's exact marker/body, never blindly re-posted. If delivery cannot be confirmed, the UI/check link remains usable; the server logs a generic notification warning. Discord delivery is deduplicated at most once per request and is not required for the UI.

No Hermes runtime settings, approval timeouts, broad permissions, or approval bypass modes are changed. Reviewer instructions prefer native file/search tools, but this feature **does not provision a pinned repository checkout**. Required unavailable context remains incomplete. Local-diff API reviews never auto-approve: a tool approval wait without an authenticated PR check binding returns an execution failure.

## Repository-scoped “Always approve” prerequisite

“Always approve this command in this repository” is displayed **disabled**, not implemented as Hermes's broad `always`/`session` choice. The installed canonical pending-control contract exposes a redacted `command`, description and choices; it does **not** attest the complete tool name, full untruncated arguments, working directory and environment needed to establish an exact invocation identity. Consequently no persistent rule is created or applied, and neither native `always` nor a client-supplied policy is accepted. There is nothing to revoke on this version.

An operational persistent/revocable repository policy requires a native authenticated full-invocation identity contract first. Matching a redacted preview, inferring missing workdir/environment, or inventing structured argument fields would be unsafe. Even a future exact rule must warn that future PRs can change code that the same command executes (for example `npm test`). This transport/UI implementation does not claim that additional persistent-policy feature is delivered.

## Private browser API

These endpoints are **not** part of the public bearer-token API or its OpenAPI security scope. Both require the configured GitHub admin's session cookie and return `Cache-Control: no-store, private`.

### `GET /api/checks/{id}/approval`

Returns `status`, `check_status`, `requests`, and (for active checks) `approval_incomplete`. Each request includes its server-bound `segment`, `prompt_id`, `execution_generation`, escaped-as-text `command` and `description`, native `choices`, and optional edit/timeout metadata. `check_status` distinguishes a completed Hermes segment from the overall completed GitHub check. No gateway token is returned. Completed checks return no actionable requests.

### `POST /api/checks/{id}/approval`

Requires `Origin: <BASE_URL origin>`, `Content-Type: application/json`, and a body of at most 4096 bytes:

```json
{"segment":1,"prompt_id":"approval_123","execution_generation":7,"choice":"once"}
```

`choice` is exactly `once` or `deny`. Extra keys, run IDs, arbitrary commands, destinations, and session-wide permissions are rejected. A success response is `{"status":"accepted","choice":"once"}` after canonical readback confirms the exact pending request is gone. Status codes: 400 invalid ID/body, 403 authentication/CSRF, 404 missing check, 409 expired/stale/replayed/uncertain decision, 413 oversized body, 503 unavailable reviewer status. A failed/ambiguous decision is not automatically replayed.

## Durability and failure handling

Startup database initialization idempotently creates the run, decision audit, PR-comment delivery, and notification tables. Each segment reserves a unique idempotency key and payload fingerprint **before** creating a Hermes run. A lost create acknowledgment retries the same payload/key; polling and decisions never submit a replacement run. Changing the credential, profile/base URL, or payload cannot adopt an existing binding. Actor, choice, generation and outcome are recorded durably.

The review worker waits up to its existing nine-minute budget, polling approximately every second. Poll errors retain run identity and eventually produce an incomplete execution failure. The page polls every 1.5 seconds and disables stale actions on status errors. Native expiry is not postponed while notifications or the operator are unavailable.

After a jean-ci process restart, existing interrupted-check recovery completes interrupted checks as neutral, without fabricating a verdict or restarting their runs. Bindings/audit remain available for diagnosis, but completed checks cannot approve tools. This implementation does not claim crash-resumable continuation of the whole multi-segment PR worker. Re-request a fresh check after investigating the interrupted run; do not repeatedly re-request a review merely because its current tool request needs a decision.

## Verification

```bash
npm test
npm run build
# Provision a disposable local database whose name starts with jean_approval_test:
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:integration
REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/jean_approval_test npm run test:approvals:http
```

The integration tests use real PostgreSQL and the real PR runner/transport/controller, with mocked Hermes/GitHub boundaries. HTTP tests start the built Next application, use task-local sealed cookies, and exercise actual handlers and detail-page rendering. They do not post live GitHub comments, send Discord notifications, or mutate a deployed Hermes runtime.
