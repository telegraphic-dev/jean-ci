---
name: triage-pr-review
description: >-
  Inspect, triage, fix, and retrigger Jean CI automated pull request reviews
  without bypassing tool-approval controls. Use when investigating failing,
  stale, incomplete, or approval-waiting PR review checks in Jean CI.
---

# Triage a Jean CI PR Review

Use this workflow whenever a pull request has failing, stale, incomplete, or in-progress Jean CI review checks.

## Workflow

1. **Discover the current PR review state**
   - Call `get_pr_reviews` with `repo` (`owner/repo`) and `prNumber`, or call `list_open_prs` to find open pull requests needing attention.
   - Check the overall rollup status (`passing`, `failing`, `in_progress`, `stale`, `pending`) and verify whether each check's `headSha` matches the PR's current head commit.

2. **Inspect individual check findings**
   - Call `get_review_check` with `checkId` for every non-passing or stale check.
   - Read `references/verdict-guide.md` to distinguish real blocking code issues from incomplete runs, transient gateway outages, or Hermes tool-approval waits.
   - Pass `includeDiff: true` only when you need the stored diff preview, and `includePrompt: true` when confirming the exact criteria enforced by a custom check.

3. **Handle tool-approval waits safely**
   - If `approvalStatus.waitingForApproval` is `true`, the Hermes reviewer is paused waiting for a human GitHub administrator to approve or deny a tool request.
   - **Never** retrigger a review solely because it is waiting for approval; instead, give the user the `detailsUrl` (`/checks/<id>`) so a GitHub administrator can review and click **Approve once** or **Deny** in the authenticated browser UI.

4. **Fix, validate locally, and retrigger**
   - For confirmed blocking `FAIL` findings, inspect the referenced local files and apply the smallest targeted fix.
   - Before pushing, run `run_local_review` with your unified `git diff` and the repository's `headSha` or `ref` to confirm Jean CI's criteria pass.
   - After pushing fixes (or recovering from a transient gateway/interrupted neutral outcome), call `retrigger_pr_review` (passing `expectedHeadSha` when available) to queue fresh GitHub checks on the current PR head.
   - Use `override_pr_review` only when the user explicitly requests recording a local Jean CI override with a clear audit reason (note that local overrides do not alter GitHub check runs or PR review status).
