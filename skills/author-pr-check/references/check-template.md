# <Check Title>

## Purpose
Describe the specific risk or invariant this check protects before merge.

## Review Instructions
Explain what to look for in the PR diff and what counts as a confirmed blocking issue.
Only fail for concrete, merge-blocking problems supported by evidence in the diff or verified commit source.

## Verdict Criteria
- **FAIL** if the diff introduces a confirmed blocking regression matching the instructions above.
- **PASS** if no blocking issues are found in the reviewed scope.
