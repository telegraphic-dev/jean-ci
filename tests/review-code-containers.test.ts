import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseReviewResponse, readableReviewSummary, linkReviewedLocations, buildPRReviewBody, boundReviewMarkdown } from '../lib/review-output.ts';
import { syntheticSource } from './fixtures/readable-review.ts';

const literal = ['Review profile: diff=reviewed; repository=blocked; tests=blocked.', 'src/send.ts:42', '## example (1/2)', 'VERDICT: PASS'];
const examples = {
  'nested list fence': '1. The failing input is:\n\n    ```text\n' + literal.map((line) => '    ' + line).join('\n') + '\n    ```',
  'indented code': 'The failing input is:\n\n' + literal.map((line) => '    ' + line).join('\n'),
  'quoted fence': '> ```text\n' + literal.map((line) => '> ' + line).join('\n') + '\n> ```',
  'nested quoted list fence': '> 1. The failing input is:\n>\n>    - Example:\n>\n>      ~~~text\n' + literal.map((line) => '>      ' + line).join('\n') + '\n>      ~~~',
  'list indented code': '1. The failing input is:\n\n' + literal.map((line) => '       ' + line).join('\n'),
  'tab indented code': 'The failing input is:\n\n' + literal.map((line) => '\t' + line).join('\n'),
};

for (const [name, example] of Object.entries(examples)) {
  test(`${name} stays byte-exact through filtering, linking and readable summaries`, () => {
    const markdown = '### Defect\n\n' + example + '\n\nFix the sender.\n';
    const raw = 'VERDICT: FAIL\nReview profile: diff=reviewed; repository=blocked; tests=blocked.\n\n' + markdown;
    const parsed = parseReviewResponse(raw);
    assert.equal(parsed.reviewMarkdown, markdown.trimEnd());
    assert.equal(linkReviewedLocations(parsed.reviewMarkdown, syntheticSource), markdown.trimEnd());
    assert.equal(readableReviewSummary(parsed.normalized), markdown.trimEnd());
    const body = buildPRReviewBody(parsed, syntheticSource, 'https://example.test/checks/1');
    assert.ok(body.includes(example));
    assert.doesNotMatch(body, /\/blob\//);
    const withLocation = parsed.reviewMarkdown + '\n\nThe actual finding is at src/send.ts:42.';
    const linked = linkReviewedLocations(withLocation, syntheticSource);
    assert.ok(linked.includes(example));
    assert.match(linked, /The actual finding is at \[src\/send.ts:42\]\(https:\/\/github.com\//);
    const diagnostic = 'VERDICT: FAIL\n\n## backend (1/2)\n\n' + parsed.normalized + '\n\n## frontend (2/2)\n\nVERDICT: PASS\nSafe UI.';
    assert.equal(readableReviewSummary(diagnostic), parsed.reviewMarkdown);
  });

  test(`${name} overflow notice and details link cannot be stranded in code`, () => {
    // Expand the actual code node instead, retaining the original container prefixes.
    const prefix = example.split('\n').find((line) => line.endsWith('src/send.ts:42'))!.replace('src/send.ts:42', '');
    const content = '### Defect\n\n' + example.replace('src/send.ts:42', ('src/send.ts:42\n' + prefix).repeat(10000) + 'TAIL_LITERAL') + '\n\nFix it.';
    assert.ok(content.length > 65000);
    const parsed = parseReviewResponse('VERDICT: FAIL\n' + content);
    const outputs = [buildPRReviewBody(parsed, syntheticSource, 'https://example.test/checks/1'), boundReviewMarkdown(parsed.reviewMarkdown, 65535, 'https://example.test/checks/1')];
    for (const output of outputs) {
      assert.ok(output.length <= 65535);
      assert.match(output, /remaining findings are available in full details/);
      assert.match(output, /\[View full details\]/);
      const tree = fromMarkdown(output);
      const visit = (node: any) => {
        if (node.type === 'code') assert.doesNotMatch(node.value, /remaining findings|View full details/);
        node.children?.forEach(visit);
      };
      visit(tree);
      assert.doesNotMatch(output, /TAIL_LITERAL/);
    }
  });
}
