# GitHub check completion reliability

A GitHub `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` returning
404 is a **GitHub check-publication failure**, not evidence that the reviewer
endpoint is missing. Inspect the exact endpoint, repository, check ID and
GitHub request ID in the server logs before diagnosing the reviewer transport.
A check that can subsequently be fetched may have experienced transient
read-after-create visibility; a later successful GET alone does not prove why
an earlier PATCH returned 404.

## Retry and durable delivery

- Check updates retry HTTP 404 on the **same check ID and payload**, at most
  four attempts with 1, 2 and 3 second waits. Authentication/permission and
  validation refusals are not retried by this policy. Check creation and PR
  review creation are never replayed by check-update retries.
- A normal PR check saves its terminal result, completion time and public
  GitHub completion payload atomically before publishing completion. Failed
  publication cannot leave the local check queued or replace a produced verdict
  with a generic execution failure. Authenticated diagnostics are stored
  separately and are not copied to GitHub by reconciliation.
- The additive startup migration creates nullable
  `jean_ci_check_runs.github_completion` JSONB. A non-null value is the durable
  public-completion outbox. The existing five-minute recovery sweep includes
  completed rows with this marker even when created **after process startup**.
  Successful immediate publication is verified and acknowledged by that sweep.
- Recovery fetches the exact remote check. If it is still nonterminal, recovery
  PATCHes the saved public completion and reads the check back before clearing
  the outbox. Provider failures or nonterminal readback retain the marker for
  a later sweep. An already-terminal remote check is not overwritten, and local
  diagnostics/verdicts are retained. No reviewer execution, tool approval, PR
  review or replacement check is dispatched by this delivery path.
- Explicit administrator restarts retain their dedicated PostgreSQL ownership
  fence and remote-first successful-completion ordering. Failed publication
  saves the completion outbox only through the still-owning session. A dead
  owner cannot replace recovery's incomplete terminal result. Pending restart
  completions are eligible after the dispatcher settles its claim.

## Boundaries

Unfinished legacy queued/in-progress rows are still recovered only when older
than the fixed startup cutoff, and only when they have a GitHub check ID.
Broadening that cutoff on every periodic sweep would race live reviews and tool
approval waits, so this change does not reclaim arbitrary live-process work by
age. A pre-ID crash or ambiguous check creation needs separate ownership-aware
recovery; do not recreate a check or blindly replay a review to repair it.

Each normal runner invocation creates a new check and retains that returned ID
in its own local check list. There is no same-head check-ID lookup/reuse in this
path. Concurrent webhook deliveries can create independent checks on the same
head; that is a separate admission/deduplication concern, not proof of ID reuse
or the cause of a particular 404. Existing approval, source-head validation and
explicit restart authorization are unchanged.

## Regression checks

```sh
npm test
npm run build
# Explicit disposable loopback database, never production:
REVIEW_APPROVAL_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/jean_approval_test_checks \
  node --test --experimental-strip-types --experimental-test-module-mocks tests/integration/check-publication.ts
REVIEW_APPROVAL_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/jean_approval_test_checks \
  npm run test:approvals:integration
```
