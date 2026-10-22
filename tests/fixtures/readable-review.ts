// Verbatim finding supplied from review 5618874084. No historical title/line invented.
export const legacyFinding = 'dashboard/src/mcp/pairing.ts, sendPaired: the owner send response’s isError flag is ignored. HTTP 200 with { text: "...", isError: true } returns kind: "sent", reporting a failed send as successful. Preserve the error flag and return an error result instead.';
export const profile = 'Review profile: diff=reviewed; repository=not needed; tests=not needed.';
export const actualReviewerOutput = `VERDICT: FAIL\n\n- ${legacyFinding}\n- ${profile}`;
export const historicalSummary = `VERDICT: FAIL\n\n- [dashboard (3/14)] ${legacyFinding}\n- [dashboard (3/14)] ${profile}`;
export const actualSource = {
  owner: 'telegraphic-dev', repo: 'a2a-exposed-site',
  headSha: '081545728347f0feae76c13b918d09b423e740a1', diff: '',
};
// Separate synthetic fixture for new structured output and verified line linking.
export const structuredOutput = 'VERDICT: FAIL\n\n### Failed sends are reported as successful\n\n**Location:** `src/send.ts:42` · sendPaired\n\n**Problem:** The response error flag is ignored, so a failed send is reported as successful.\n\n**Fix:** Preserve the error flag and return an error result; do not retry the send.\n\n- Preserve the response:\n  Keep continuation indentation.\n\n```ts\n  return { isError: response.isError };\n```\n\n- ' + profile;
export const syntheticSource = { ...actualSource, diff: 'diff --git a/src/send.ts b/src/send.ts\n--- a/src/send.ts\n+++ b/src/send.ts\n@@ -42 +42 @@\n-old\n+new\n' };
