# Jean CI Review Verdict & Outcome Guide

| Status / Conclusion | Meaning | Recommended Action |
| --- | --- | --- |
| `completed` / `success` | Check returned **VERDICT: PASS** with no blocking findings. | No action needed unless `headSha` is stale relative to the PR head. |
| `completed` / `failure` | Confirmed blocking code findings (**VERDICT: FAIL**) or invalid custom check prompt. | Inspect findings via `get_review_check`, fix the blocking issue (or fix `.jean-ci/pr-checks/*.md`), verify locally with `run_local_review`, then push and retrigger. |
| `completed` / `neutral` | Transient gateway/provider outage, interrupted restart, caller cancellation, or superseded by a newer commit. | Confirm the PR head is current and call `retrigger_pr_review`. |
| `in_progress` + `waitingForApproval: true` | Hermes reviewer paused for human administrator tool consent. | Direct a GitHub administrator to open `detailsUrl` (`/checks/<id>`) in their browser to approve once or deny. Do not spam retriggers. |
| `queued` / `in_progress` | Review check is actively running. | Wait and poll `get_review_check`, monitor MCP Task progress (`io.modelcontextprotocol/tasks`), or subscribe to `pr_review.completed` via MCP Events (`io.modelcontextprotocol/events`). |
