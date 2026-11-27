---
trigger: glob
globs: ".jean-ci/pr-checks/*.md"
description: Structural and quality rules for custom Jean CI PR review checks under .jean-ci/pr-checks/*.md
---

# Custom Jean CI PR Check Rules

- Every `.jean-ci/pr-checks/*.md` file MUST include an H1 title (`# <Title>`), `## Purpose`, `## Review Instructions`, and `## Verdict Criteria` with explicit **PASS** and **FAIL** conditions.
- Keep criteria focused on concrete, verifiable, merge-blocking risks rather than subjective style preferences.
- Custom checks run additively alongside the global `jean-ci / Code Review` check; do not duplicate generic code review instructions.
- After creating or editing a check prompt, validate it against a sample diff using the Jean CI MCP `run_local_review` tool (or `list_pr_check_definitions`) before merging.
