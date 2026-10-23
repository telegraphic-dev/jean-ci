# Coolify 4.0.0 → 4.4.7 deployment migration gate

**Status: source-contract qualified, not live-4.4.7 qualified.** This change does not
upgrade Coolify, change infrastructure, or authorize a production deployment.

## Tagged-source findings

Compared upstream tags `v4.0.0` (`96bfc14543c893f0b0156b12c40250d3f8cc96a2`)
and `v4.4.7` (`86c21c0d5babfa8c7d65a9c27e5863c629a89c7c`):

| Contract | Finding / jean-ci behavior |
| --- | --- |
| Trigger methods | In [4.0.0 routes](https://github.com/coollabsio/coolify/blob/v4.0.0/routes/api.php), `/deploy` and application lifecycle actions accept GET/POST. In [4.4.7 routes](https://github.com/coollabsio/coolify/blob/v4.4.7/routes/api.php), GET is routed to `OtherController::post_required` (405); POST performs the action. jean-ci **already uses POST** `/api/v1/applications/{uuid}/start`; retain it. Old GET `/deploy?uuid=...` helper/runbook examples must be replaced with POST separately. Do not switch to `/restart` as a fallback. |
| Queue receipt | `ApplicationsController::action_deploy` returns `{message, deployment_uuid}` when queued and **HTTP 200 with only `{message}` when skipped**, in both tags. Require a nonempty string receipt; missing configuration, skipped/malformed responses, transport and non-2xx failures cannot report success. Never automatically retry an uncertain POST. |
| Identifier | Old controller constructs Cuid2; new controller uses `new_public_id()`. Treat returned deployment IDs as opaque strings, not a fixed UUID/Cuid format. |
| App metadata | `application_by_uuid` returns the sanitized application, not an eagerly loaded project/environment. 4.4.7 additionally loads settings. Flat records with `environment_id` are valid; do not manufacture `/project/default/production/...` links. Use the dashboard root until real relationship UUIDs or the webhook's deployment URL are available. |
| Polling | `DeployController::deployment_by_uuid` still returns a flat deployment record at GET `/api/v1/deployments/{uuid}`. Do not confuse it with GET `/deployments/applications/{uuid}`, which returns `{count, deployments}`. |
| Terminal statuses | Both [4.0.0](https://github.com/coollabsio/coolify/blob/v4.0.0/app/Enums/ApplicationDeploymentStatus.php) and [4.4.7](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Enums/ApplicationDeploymentStatus.php) use `finished`, `failed`, **`cancelled-by-user`**; `queued` and `in_progress` are nonterminal. |
| Webhooks | `DeploymentSuccess::toWebhook` and `DeploymentFailed::toWebhook` are unchanged between tags: `event`, `application_uuid`, `deployment_uuid`, `deployment_url`, `message`, names and optional preview fields. Match both application and deployment ID; ignore missing/mismatched IDs and preview notifications for production completion. |

Controller sources: [old applications](https://github.com/coollabsio/coolify/blob/v4.0.0/app/Http/Controllers/Api/ApplicationsController.php),
[new applications](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Http/Controllers/Api/ApplicationsController.php),
[old deployments](https://github.com/coollabsio/coolify/blob/v4.0.0/app/Http/Controllers/Api/DeployController.php),
[new deployments](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Http/Controllers/Api/DeployController.php).
Webhook sources (same files in both tags):
[success](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Notifications/Application/DeploymentSuccess.php),
[failure](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Notifications/Application/DeploymentFailed.php).

## Completion guarantees and remaining limits

Webhooks and sync polling now share GitHub completion: publish deployment status
and check conclusion **before** removing pending tracking, with strict delivery
errors for the deployment-status call. Polling recovers missed webhooks, including
cancelled deployments. Failure retains the pending receipt for retry. Deletion is
conditional on the deployment ID so late completion cannot delete a newer row.
Age over 30 minutes and 404 are diagnostic, not proof of completion: tracking is
retained and old builds are still polled. Unresolvable records require operator
reconciliation, rather than silently leaving GitHub in progress after cleanup.

This is not an exactly-once system: concurrent webhook/poll delivery can repeat
GitHub updates or smoke-test scheduling. There is still one pending slot per app;
a crash between POST acceptance and pending registration, or overlapping starts,
can lose tracking. Legacy pending rows without a receipt cannot be safely matched
by app alone. Smoke tests remain best-effort asynchronous work. This patch does
not add webhook authentication; deployment IDs are correlation, not credentials.
Verify the existing endpoint's network/auth protection before exposing it.
Polling recovery requires the existing `/api/sync` job actually to run with valid
Coolify and GitHub credentials. Tests use mocked network/database boundaries;
there is no real PostgreSQL concurrency or live webhook-delivery proof here.

## Required operational gate (separate approved change)

- [ ] Secure a fresh, verified, restorable off-host backup, including Coolify DB,
  persistent configuration and **APP_KEY**. Record recovery/rollback procedure;
  do not assume a newer schema can be downgraded in place.
- [ ] Resolve disk headroom before upgrade/image pulls. The accompanying host
  audit reported 95% used and approximately 18 GB free; remeasure, do not treat
  that snapshot as current capacity approval. Drain all pending deployments.
- [ ] Review the [Reverb migration](https://coolify.io/docs/core/instance-management/reverb-migration)
  against the actual custom compose and proxy. The audited installation has old
  `coolify-realtime:1.0.13` publishing 6001/6002 and main Coolify exposing only
  8000→8080. 4.4 consolidates realtime/terminal into main Coolify and removes the
  realtime container with compatibility aliasing; validate ports, aliases,
  websocket and terminal routes, not only HTTP health.
- [ ] Confirm API URL, token read/deploy abilities and team scope from the actual
  jean-ci network. Keep TLS validation enabled. The accompanying audit could
  reach internal 4.0.0 API; public API paths returned 403 and one public hostname
  had a TLS mismatch. Fix routing/certificates rather than bypassing validation.
- [ ] Check the security release notes for [v4.4.7](https://github.com/coollabsio/coolify/releases/tag/v4.4.7)
  and the supported upgrade path. An interim 4.0.1 security patch may be considered
  explicitly; no patch or full upgrade is automatically authorized by this doc.
- [ ] After explicit approval, use a non-production canary on the exact candidate
  version: push image → jean-ci POST `/start` → receipt → exact-ID status/webhook
  → completed GitHub deployment/check → smoke test. Exercise failure,
  cancellation, missed webhook with polling, and replay of an older receipt.
  Verify running image revision and actual application behavior, not just 200.
- [ ] Only then approve the production window and record the same evidence there.

Local verification: `npm test` and `npm run build`; the Coolify regression suite
exercises the real trigger, provider, webhook handler and sync function with
synthetic tagged-contract responses. These checks are **not** an upgrade rehearsal,
live 4.4.7 canary, backup verification, or proof of realtime/proxy compatibility.
