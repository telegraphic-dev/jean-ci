import { SkillsExtension, memorySkillFiles, type SkillCatalog } from '@modelcontextprotocol/server/ext/skills';

const TRIAGE_PR_REVIEW_SKILL = `---
name: triage-pr-review
description: Inspect, triage, fix, and retrigger jean-ci automated PR reviews without bypassing tool approval controls.
---

# Triage a jean-ci PR Review

Use this workflow when investigating failing, incomplete, stale, or in-progress pull request reviews in jean-ci.

## Workflow

1. **Discover the current PR review state**
   - Call \`get_pr_reviews\` with \`repo\` (\`owner/repo\`) and \`prNumber\`, or \`list_open_prs\` to find PRs needing attention.
   - Check the overall rollup status (\`passing\`, \`failing\`, \`in_progress\`, \`stale\`, \`pending\`) and compare each check's \`headSha\` with the PR's current head.

2. **Inspect individual check findings**
   - Call \`get_review_check\` with the check \`checkId\`.
   - Read \`references/verdict-guide.md\` to distinguish real blocking code issues from incomplete runs, gateway outages, or tool-approval waits.
   - Pass \`includeDiff: true\` only when you need the stored diff preview, and \`includePrompt: true\` when verifying what criteria the check enforced.

3. **Handle tool-approval waits safely**
   - If \`approvalStatus.waitingForApproval\` is \`true\`, the reviewer is paused waiting for a human GitHub administrator to approve or deny a tool call.
   - **Never** retrigger a review merely because it is waiting for approval; instead, give the human administrator the \`detailsUrl\` (\`/checks/<id>\`) so they can review and click **Approve once** or **Deny** in the authenticated browser UI.

4. **Fix, validate locally, and retrigger**
   - For confirmed blocking \`FAIL\` findings, apply the smallest targeted fix in the codebase.
   - Before pushing, run \`run_local_review\` with your unified \`git diff\` and the repository's \`headSha\` or \`ref\` to confirm jean-ci's criteria pass.
   - Once fixes are pushed (or after a transient gateway/interrupted failure), call \`retrigger_pr_review\` to queue fresh GitHub checks on the current PR head.
   - Use \`override_pr_review\` only when a human explicitly authorizes recording a local jean-ci override with an audit reason (remember: overrides do not modify GitHub check runs or PR reviews).
`;

const VERDICT_GUIDE_REFERENCE = `# jean-ci Review Verdict & Outcome Guide

| Status / Conclusion | Meaning | Recommended Action |
| --- | --- | --- |
| \`completed\` / \`success\` | Check returned **VERDICT: PASS** with no blocking findings. | No action needed unless \`headSha\` is stale relative to the PR head. |
| \`completed\` / \`failure\` | Confirmed blocking code findings (**VERDICT: FAIL**) or invalid custom prompt. | Inspect findings via \`get_review_check\`, fix the blocking issue (or fix \`.jean-ci/pr-checks/*.md\`), verify with \`run_local_review\`, then push/retrigger. |
| \`completed\` / \`neutral\` | Transient gateway/provider outage, interrupted restart, or superseded by a newer commit. | Confirm the PR head is current and call \`retrigger_pr_review\`. |
| \`in_progress\` + \`waitingForApproval: true\` | Hermes reviewer paused for human administrator tool consent. | Direct a GitHub admin to open \`detailsUrl\` (\`/checks/<id>\`) in their browser. Do not spam retriggers. |
| \`queued\` / \`in_progress\` | Review check is actively running. | Wait or poll \`get_review_check\` (or MCP Task status if triggered via \`io.modelcontextprotocol/tasks\`). |
`;

const AUTHOR_PR_CHECK_SKILL = `---
name: author-pr-check
description: Author and validate repository-specific .jean-ci/pr-checks/*.md review prompts and test them against diffs.
---

# Author a Custom jean-ci PR Check

Custom checks live under \`.jean-ci/pr-checks/<name>.md\` and run **additively** alongside the always-on \`jean-ci / Code Review\` check.

## Steps

1. **Inspect existing repository checks**
   - Call \`list_pr_check_definitions\` with \`repo\` (and optional \`ref\`) to see the active global \`Code Review\` criteria and all existing \`.jean-ci/pr-checks/*.md\` files plus their validation status.

2. **Follow required prompt structure**
   - Read \`references/check-template.md\` for the exact required sections.
   - Every custom check MUST include:
     - A Markdown H1 title (\`# <Check Title>\`)
     - \`## Purpose\`
     - \`## Review Instructions\`
     - \`## Verdict Criteria\` containing explicit **PASS** and **FAIL** conditions

3. **Keep criteria focused and pragmatic**
   - Target concrete, merge-blocking risks (security, migrations, contract parity, test regressions).
   - Avoid nitpicks or style rules that cause noisy false-positive failures.

4. **Test before merging**
   - Call \`run_local_review\` with \`repo\`, \`ref\` (or \`headSha\`), \`diff\`, and \`selectedChecks: ["<name>"]\` to verify the check parses cleanly and produces accurate verdicts.
`;

const CHECK_TEMPLATE_REFERENCE = `# <Check Title>

## Purpose
Describe the specific risk or invariant this check protects before merge.

## Review Instructions
Explain what to look for in the PR diff and what counts as a confirmed blocking issue.
Only fail for concrete, merge-blocking problems supported by evidence in the diff or verified commit source.

## Verdict Criteria
- **FAIL** if the diff introduces a confirmed blocking regression matching the instructions above.
- **PASS** if no blocking issues are found in the reviewed scope.
`;

let cachedCatalogPromise: Promise<SkillCatalog> | null = null;

export function getJeanCiSkillCatalog(): Promise<SkillCatalog> {
  if (!cachedCatalogPromise) {
    const files = memorySkillFiles({
      'triage-pr-review/SKILL.md': TRIAGE_PR_REVIEW_SKILL,
      'triage-pr-review/references/verdict-guide.md': VERDICT_GUIDE_REFERENCE,
      'author-pr-check/SKILL.md': AUTHOR_PR_CHECK_SKILL,
      'author-pr-check/references/check-template.md': CHECK_TEMPLATE_REFERENCE,
    });

    cachedCatalogPromise = SkillsExtension.load(files, {
      prefix: 'jean-ci',
      strict: true,
      cacheHint: { ttlMs: 300_000, cacheScope: 'public' },
    });
  }
  return cachedCatalogPromise;
}
