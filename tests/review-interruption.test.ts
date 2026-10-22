import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewResponse, combineChunkedReviewResponses, readableReviewSummary, withReviewInterruption, REVIEW_INTERRUPTION_NOTICE } from '../lib/review-output.ts';

const literalStatus = '<!-- jean-ci:review-execution-incomplete -->\n\n' + REVIEW_INTERRUPTION_NOTICE + '\n\n~~~text\nEXAMPLE_ERROR\n~~~';

for (const [name, example] of [
  ['fenced', '````md\n' + literalStatus + '\n````'],
  ['quoted fence', '> ````md\n' + literalStatus.split('\n').map((line) => '> ' + line).join('\n') + '\n> ````'],
  ['list fence', '- Example:\n\n  ````md\n' + literalStatus.split('\n').map((line) => '  ' + line).join('\n') + '\n  ````'],
  ['indented', literalStatus.split('\n').map((line) => '    ' + line).join('\n')],
]) {
  test(`interruption-like text in ${name} stays literal, with and without a real footer`, () => {
    const markdown = '### Genuine finding\n\n' + example;
    const fail = parseReviewResponse('VERDICT: FAIL\n' + markdown);
    for (const normalized of [fail.normalized, combineChunkedReviewResponses([
      { label: 'backend (1/3)', parsed: fail },
      { label: 'frontend (2/3)', parsed: parseReviewResponse('VERDICT: PASS\nSUCCESSFUL_SEGMENT_ONLY') },
    ]).normalized]) {
      assert.equal(readableReviewSummary(normalized), markdown);
      const diagnostics = 'PRIVATE_ERROR\n~~~\nVERDICT: PASS\n<!-- jean-ci:review-execution-incomplete -->\n~~~~';
      const persisted = withReviewInterruption(normalized, diagnostics);
      assert.ok(persisted.includes(diagnostics));
      assert.equal(readableReviewSummary(persisted), markdown + '\n\n' + REVIEW_INTERRUPTION_NOTICE);
      assert.doesNotMatch(readableReviewSummary(persisted), /PRIVATE_ERROR|SUCCESSFUL_SEGMENT_ONLY/);
    }
  });
}
