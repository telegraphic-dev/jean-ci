---
name: local-pr-review
description: >-
  Run Jean CI's automated Code Review and custom .jean-ci/pr-checks/*.md checks
  locally against an uncommitted or branch git diff before pushing. Use when
  the user wants a pre-push Jean CI review or wants to verify fixes locally.
---

# Local Pre-Push Review with Jean CI

Use this workflow to validate local code changes against Jean CI's exact review criteria before pushing commits or opening a pull request.

## Workflow

1. **Identify repository and ref**
   - Determine the GitHub `owner/repo` slug (for example, from `git remote get-url origin`) and the base commit or branch ref (`headSha` or `ref`).
   - Optionally call `list_pr_check_definitions` with `repo` and `ref` to see which checks (`Code Review` plus any `.jean-ci/pr-checks/*.md` checks) apply to this repository.

2. **Collect a clean unified diff**
   - For uncommitted changes, capture `git diff HEAD` by default so both staged and unstaged changes are reviewed (use plain `git diff` only if the user explicitly asks for an unstaged-only review).
   - For a feature branch compared against `main`, capture `git diff origin/main...HEAD`.
   - Avoid including generated lockfiles or binary noise if the diff is very large; focus on the code changes under review.

3. **Run `run_local_review`**
   - Call the Jean CI MCP tool `run_local_review` with:
     - `repo`: `"owner/repo"`
     - `diff`: the unified git diff
     - `ref` or `headSha`: target ref so Jean CI loads repository-specific `.jean-ci/pr-checks/*.md` rules
     - `selectedChecks` (optional): restrict to specific check names when iterating quickly on a single rule
   - Note that `run_local_review` supports MCP Tasks for long-running reviews.

4. **Summarize findings and iterate**
   - Report the verdict (`PASS` / `FAIL`) for every executed check, citing concrete file paths and blocking issues.
   - If any check returns `FAIL`, propose or apply the smallest targeted fix and re-run `run_local_review` until all checks pass.
