---
name: author-pr-check
description: >-
  Author, validate, and test repository-specific .jean-ci/pr-checks/*.md review
  prompts against diffs in Jean CI. Use when creating or updating custom Jean CI
  pull request review rules.
---

# Author a Custom Jean CI PR Check

Custom checks live under `.jean-ci/pr-checks/<name>.md` and run **additively** alongside the always-on `jean-ci / Code Review` check.

## Workflow

1. **Inspect existing repository checks**
   - Call `list_pr_check_definitions` with `repo` (and optional `ref`) to see the active global `Code Review` criteria, existing `.jean-ci/pr-checks/*.md` files, and their validation status.

2. **Follow the required prompt structure**
   - Read `references/check-template.md` for the exact template.
   - Every custom check file MUST contain:
     - A Markdown H1 title (`# <Check Title>`)
     - `## Purpose`
     - `## Review Instructions`
     - `## Verdict Criteria` with explicit **PASS** and **FAIL** conditions

3. **Keep criteria focused and evidence-based**
   - Target concrete, merge-blocking risks (security boundaries, schema migrations, API/OpenAPI parity, backwards-compatibility regressions).
   - Avoid subjective style nitpicks that create noisy false-positive failures.

4. **Validate against a real diff before merging**
   - Call `run_local_review` with `repo`, `ref` (or `headSha`), `diff`, and `selectedChecks: ["<name>"]` to verify the prompt parses cleanly and returns accurate `PASS` / `FAIL` verdicts.
