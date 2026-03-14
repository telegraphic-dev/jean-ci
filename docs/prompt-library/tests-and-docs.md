# Tests and Docs Coverage

## Purpose
Ensure behavior-changing PRs ship with enough validation and user-facing documentation.

## Review Instructions
Review the diff for feature or behavior changes and check whether the PR includes:
- test coverage for the changed behavior, or a clear reason why tests are not applicable
- documentation or README updates when setup, usage, or operator workflows changed
- migration notes when rollout steps are required

Do not fail for tiny refactors that do not change behavior.

## Verdict Criteria
- **FAIL** if the PR changes user-visible or operator-visible behavior without required tests or docs.
- **PASS** if tests/docs are sufficient for the scope of the change.
