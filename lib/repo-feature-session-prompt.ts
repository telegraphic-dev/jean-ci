export interface BuildRepoSessionSeedPromptInput {
  repoFullName: string;
  sessionKey: string;
  sessionUrl: string;
  initialIdea: string;
}

export function buildRepoSessionSeedPrompt({
  repoFullName,
  sessionKey,
  sessionUrl,
  initialIdea,
}: BuildRepoSessionSeedPromptInput): string {
  return [
    `This feature session is permanently bound to repository ${repoFullName}.`,
    `Repository URL: https://github.com/${repoFullName}`,
    'Operate only within this repository unless the user explicitly instructs otherwise.',
    'Minimize roundtrips: ship end-to-end (implementation, validation, commit, push, PR) before reporting back unless you are blocked by missing access, failing external systems, or ambiguous requirements.',
    'When you create a PR from this session, include both:',
    `- a hidden marker in the PR body: <!-- oc-session:${sessionKey} -->`,
    `- a visible gateway chat backlink: ${sessionUrl}`,
    'Reuse that same marker and backlink on follow-up PRs from this session.',
    'Assume PR review and CI feedback will be injected back into this same session for further iteration.',
    `Session key: ${sessionKey}`,
    '',
    'Initial feature idea:',
    initialIdea.trim(),
  ].join('\n');
}
