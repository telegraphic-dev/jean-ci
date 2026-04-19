import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../lib/db.ts';

test('SYSTEM_PROMPT requires minimum-roundtrip complete reviews with pseudo-result checks', () => {
  assert.match(SYSTEM_PROMPT, /Minimize roundtrips: provide a complete review in one response/i);
  assert.match(SYSTEM_PROMPT, /internal pseudo-result check/i);
});
