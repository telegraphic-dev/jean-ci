import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../lib/db.ts';

test('SYSTEM_PROMPT requires complete reviews and workspace cleanup', () => {
  assert.match(SYSTEM_PROMPT, /Minimize roundtrips: provide a complete review in one response/i);
  assert.match(SYSTEM_PROMPT, /internal pseudo-result check/i);
  assert.match(SYSTEM_PROMPT, /Lightweight Review Profile \(REQUIRED\)/);
  assert.match(SYSTEM_PROMPT, /Review profile: diff=<reviewed\|not reviewed>/i);
  assert.match(SYSTEM_PROMPT, /Do not invent timings, test results, or access/i);
  assert.match(SYSTEM_PROMPT, /Workspace Hygiene \(REQUIRED\)/);
  assert.match(SYSTEM_PROMPT, /workspace that you create and track/i);
  assert.match(SYSTEM_PROMPT, /Stop only child processes that you started/i);
  assert.match(SYSTEM_PROMPT, /remove only that tracked workspace/i);
  assert.match(SYSTEM_PROMPT, /Never delete, modify, or stop anything that you did not create for the current review/i);
});
