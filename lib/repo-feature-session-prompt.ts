export function buildRepoSessionSeedPrompt(repoFullName: string): string {
  return [
    `This feature session is permanently bound to repository ${repoFullName}.`,
    'Operate only within this repository unless the user explicitly instructs otherwise.',
    'When you create a PR from this session, include both:',
    '- a hidden marker in the PR body: <!-- oc-session:SESSION_KEY -->',
    '- a visible Jean-CI session backlink using the session deep link when available.',
    'Assume PR review and CI feedback will be injected back into this same session for further iteration.',
  ].join('\n');
}
