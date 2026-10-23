import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reviewDiagnostics } from '../lib/review-diagnostics.ts';
import { terminalDiagnostic } from '../lib/hermes-runs.ts';
import type { RunBinding } from '../lib/hermes-runs.ts';
const binding = (segment = 1): RunBinding => ({ check_id: 5, segment, scope: 'owner', run_id: `run_${segment}`, request_key: 'key', status: 'completed', pending: [], denied: true });
const output = 'VERDICT: INCOMPLETE\nRequired dependency contracts are unavailable in the pinned checkout because approval was not granted. No confirmed defect.';

test('terminal diagnostics whitelist final output and safe status, not tools, reasoning or raw errors', () => {
  const run = { run_id: 'run_1', status: 'failed', output, messages: ['private transcript'], reasoning: 'hidden', error: 'Bearer secret', pending_controls: [{ command: 'SECRET_TOOL_ARGUMENT' }] };
  assert.deepEqual(terminalDiagnostic(run as any), { status: 'failed', output, error: 'native_run_failed' });
  assert.equal(terminalDiagnostic({ run_id: 'run_1', status: 'running', output }), null);
});
test('historical hydration uses exact server binding and scope; is read-only and budgeted', async () => {
  const calls: string[] = [];
  const deps = { getCheck: async () => ({}), getBindings: async () => Array.from({ length: 7 }, (_, i) => binding(i + 1)),
    client: { scope: 'owner', status: async (id: string) => { calls.push(id); return { run_id: id, status: 'completed', output, messages: ['SECRET_TOOL_ARGUMENT'] }; } } };
  const first = (await reviewDiagnostics(5, 0, deps))!;
  assert.equal(first.parts.length, 4); assert.equal(first.next, 4); assert.equal(calls.length, 4);
  assert.equal(first.parts[0].diagnostic?.output, output); assert.equal(first.parts[0].denied, true);
  assert.doesNotMatch(JSON.stringify(first), /SECRET_TOOL_ARGUMENT|run_1|owner/);
  const second = (await reviewDiagnostics(5, first.next!, deps))!;
  assert.equal(second.parts.length, 3); assert.equal(second.next, null); assert.equal(calls.length, 7);
});
test('source missing, scope mismatch, run mismatch, no bindings and missing check are honest', async () => {
  let calls = 0;
  const deps = { getCheck: async (): Promise<unknown> => ({}), getBindings: async () => [binding()],
    client: { scope: 'foreign', status: async (id: string) => { calls++; return { run_id: id, status: 'completed', output }; } } };
  assert.equal((await reviewDiagnostics(5, 0, deps))!.parts[0].source, 'unavailable'); assert.equal(calls, 0);
  deps.client.scope = 'owner';
  deps.client.status = async () => { throw new Error('private provider error'); };
  assert.equal((await reviewDiagnostics(5, 0, deps))!.parts[0].diagnostic, null);
  deps.client.status = async () => ({ run_id: 'another_run', status: 'completed', output });
  assert.equal((await reviewDiagnostics(5, 0, deps))!.parts[0].source, 'unavailable');
  deps.getBindings = async () => [];
  assert.deepEqual(await reviewDiagnostics(5, 0, deps), { parts: [], next: null });
  deps.getCheck = async () => null;
  assert.equal(await reviewDiagnostics(5, 0, deps), null);
});
test('persisted terminal evidence needs no native request and is still scope fenced', async () => {
  const b = { ...binding(), diagnostic: terminalDiagnostic({ run_id: 'run_1', status: 'completed', output }) };
  const deps = { getCheck: async () => ({}), getBindings: async () => [b], client: { scope: 'owner', status: async (): Promise<never> => { throw new Error('must not fetch'); } } };
  assert.equal((await reviewDiagnostics(5, 0, deps))!.parts[0].source, 'persisted');
  deps.client.scope = 'foreign';
  assert.equal((await reviewDiagnostics(5, 0, deps))!.parts[0].diagnostic, null);
});
test('actual details render distinct source output with human labels and collapsed defaults', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--loader', new URL('./support/tsx-loader.mjs', import.meta.url).href, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
    const { CheckReviewContent } = await import(${JSON.stringify(new URL('../components/CheckReviewContent.tsx', import.meta.url).href)});
    const { ReviewPartContent } = await import(${JSON.stringify(new URL('../components/NativeReviewDetails.tsx', import.meta.url).href)});
    const summary = 'Reviewer execution failed INCOMPLETE Approval-aware review unavailable';
    const html = renderToStaticMarkup(createElement(CheckReviewContent, { summary, repo: 'owner/repo', headSha: 'a'.repeat(40), diagnosticCheckId: 5 }));
    assert.equal(html.split(summary).length - 1, 1);
    assert.doesNotMatch(html, /<details[^>]* open/);
    const details = renderToStaticMarkup(createElement(ReviewPartContent, { part: { segment: 6, status: 'completed', denied: true, source: 'canonical', diagnostic: { status: 'completed', output: ${JSON.stringify(output)}, error: null } } }));
    assert.match(details, /Review part 6/); assert.match(details, /Required dependency contracts/); assert.match(details, /cannot establish a complete review/);
    assert.doesNotMatch(details, /Reviewer execution failed INCOMPLETE/);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
