import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight, startSequentialPolling } from '../lib/sequential-polling.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('scheduled and action refresh share one in-flight request and recover after rejection', async () => {
  let calls = 0;
  let release!: () => void;
  const refresh = singleFlight(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); });
  const first = refresh();
  const second = refresh();
  await flush();
  assert.equal(calls, 1);
  assert.equal(first, second);
  release(); await first;
  const third = refresh(); await flush(); assert.equal(calls, 2); release(); await third;
  let attempts = 0;
  const failing = singleFlight(async () => { attempts++; throw new Error('unavailable'); });
  await assert.rejects(failing()); await assert.rejects(failing()); assert.equal(attempts, 2);
});

test('slow polling never overlaps and stopping prevents deferred refreshes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let release!: () => void;
  const stop = startSequentialPolling(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); }, 1500);
  assert.equal(calls, 1);
  t.mock.timers.tick(60_000); assert.equal(calls, 1);
  release(); await flush();
  t.mock.timers.tick(1499); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.equal(calls, 2);
  stop(); release(); await flush();
  t.mock.timers.tick(60_000); assert.equal(calls, 2);
});

test('polling can retry a failed refresh without an unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startSequentialPolling(async () => { calls++; throw new Error('unavailable'); }, 1500);
  await flush(); t.mock.timers.tick(1500); await flush(); assert.equal(calls, 2);
  stop(); t.mock.timers.tick(60_000); assert.equal(calls, 2);
});
