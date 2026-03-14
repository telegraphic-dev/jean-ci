# Migration Safety

## Purpose
Catch rollout risks for changes that alter persistent data, contracts, or deploy sequencing.

## Review Instructions
Review the diff for:
- schema or data model changes
- renamed/removed config keys or environment variables
- API contract changes that need compatibility planning
- deploy ordering problems or missing backfill/migration steps

Fail only when the change is unsafe to merge without an explicit migration path.

## Verdict Criteria
- **FAIL** if the PR introduces a breaking migration or rollout hazard without a safe plan.
- **PASS** if no migration risk exists, or the migration path is explicit and safe.
