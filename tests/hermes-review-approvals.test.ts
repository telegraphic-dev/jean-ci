import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalPrompts, hermesClient, runHermesReview, observedApproval } from '../lib/hermes-runs.ts';
import type { RunBinding, RunStore, HermesRun } from '../lib/hermes-runs.ts';
import { decideReviewApproval, getReviewApprovals, parseApprovalDecision, requireApprovalCsrf, validCheckId } from '../lib/review-approvals.ts';
import type { ApprovalDeps } from '../lib/review-approvals.ts';
import { APP_BASE_URL } from '../lib/config.ts';

const prompt = { kind: 'approval' as const, prompt_id: 'approval_1', execution_generation: 7, command: 'python read-source.py', description: 'Read required CSRF context', choices: ['once', 'deny', 'session', 'always'] };
const waiting: HermesRun = { run_id: 'run_test', status: 'waiting_for_approval', execution_generation: 7, pending_controls: [prompt] };
const completed: HermesRun = { run_id: 'run_test', status: 'completed', output: 'VERDICT: PASS\nNo defects.' };
function fixture() {
  let binding: RunBinding = { check_id: 1, segment: 1, run_id: null, scope: 'scope', request_key: 'persisted-key', status: 'submitting', pending: [], denied: false };
  let current = structuredClone(waiting);
  const decisions: any[] = [];
  let creates = 0;
  let posts = 0;
  const store: RunStore = {
    reserve: async () => structuredClone(binding),
    bind: async (_c, _s, id) => { binding.run_id = id; },
    get: async () => [structuredClone(binding)],
    observe: async (_b, fetchRun) => { const run = await fetchRun(); binding.status = run.status; binding.pending = approvalPrompts(run); return run; },
  };
  const client = {
    scope: 'scope', supported: async () => true,
    create: async () => { creates++; return { run_id: 'run_test', status: 'queued' }; },
    status: async () => structuredClone(current),
    decide: async (_id: string, _p: typeof prompt, choice: string) => {
      posts++; current = structuredClone(completed);
      if (choice === 'deny') binding.denied = true;
      return { status: 'resolved' };
    },
  };
  const deps = {
    getCheck: async () => ({ id: 1, repo: 'owner/repo', pr_number: 2, head_sha: 'head', status: 'in_progress' }),
    getRepo: async () => ({ installation_id: 3, pr_review_enabled: true }),
    getInstallationOctokit: async () => ({}), getPRInfo: async () => ({ head: { sha: 'head' }, state: 'open' }),
    store, client: () => client,
    claim: async (_b: any, p: any, choice: string, actor: string) => {
      if (decisions.some(d => d.id === p.prompt_id && d.generation === p.execution_generation)) return false;
      decisions.push({ id: p.prompt_id, generation: p.execution_generation, choice, actor }); return true;
    },
    finish: async (_b: any, _p: any, outcome: string, choice: string) => { if (choice === 'deny' || outcome !== 'accepted') binding.denied = true; },
  } as unknown as ApprovalDeps;
  return { client, store, deps, decisions, binding, get creates() { return creates; }, get posts() { return posts; }, setCurrent: (r: HermesRun) => { current = r; } };
}

test('Runs waits without auto-approving; explicit once resumes the same run', async () => {
  const f = fixture(); let waits = 0; let deciding: Promise<unknown> | undefined;
  const result = await runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, sleep: async () => { await new Promise(r => setImmediate(r)); }, onWaiting: async () => {
    waits++;
    assert.equal(f.posts, 0);
    const status = await getReviewApprovals(1, f.deps);
    assert.equal(status.requests[0].command, prompt.command);
    deciding = decideReviewApproval(1, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'once' }, 'operator', f.deps);
  } });
  await deciding;
  assert.match(result, /PASS/); assert.equal(f.creates, 1); assert.equal(f.posts, 1); assert.equal(waits, 1);
  assert.equal(f.binding.run_id, 'run_test'); assert.equal(f.decisions[0].actor, 'operator');
});

test('worker waits for concurrent decision settlement after native completion, not the onWaiting callback', async () => {
  const f = fixture();
  let release!: () => void;
  const acknowledgement = new Promise<void>(r => { release = r; });
  const originalDecide = f.client.decide;
  f.client.decide = async (...args) => {
    const receipt = await originalDecide(...args);
    f.binding.settling = true;
    await acknowledgement;
    return receipt;
  };
  const originalFinish = f.deps.finish;
  f.deps.finish = async (...args) => { await originalFinish(...args); f.binding.settling = false; };
  let deciding: Promise<unknown> | undefined, completionSeen = false;
  const result = await runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1,
    onWaiting: async () => { deciding = decideReviewApproval(1, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'once' }, 'operator', f.deps); },
    sleep: async () => {
      await new Promise(r => setImmediate(r));
      if (f.binding.status === 'completed' && f.binding.settling) {
        completionSeen = true; release(); await deciding;
      }
    },
  });
  await deciding;
  assert.equal(completionSeen, true); assert.match(result, /PASS/);
  assert.equal(f.creates, 1); assert.equal(f.posts, 1);
});

test('in-flight settlement fails closed on uncertainty, lease expiry or overall deadline', async () => {
  for (const outcome of ['uncertain', 'expired', 'deadline']) {
    const f = fixture(); f.setCurrent(completed); f.binding.settling = true;
    let waits = 0;
    await assert.rejects(runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1,
      deadlineMs: outcome === 'deadline' ? 10 : 1000,
      sleep: async () => { waits++; if (outcome !== 'deadline') { f.binding.denied = true; f.binding.settling = false; } else await new Promise(r => setTimeout(r, 15)); },
    }), outcome === 'deadline' ? /Timed out/ : /could not be confirmed/);
    assert.equal(waits, 1); assert.equal(f.posts, 0); assert.equal(f.creates, 1);
  }
});

test('optional wait announcement failure retries on the same run and leaves approval usable', async () => {
  const f = fixture(); let calls = 0; let deciding: Promise<unknown> | undefined;
  const result = await runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1,
    sleep: async () => { await new Promise(r => setImmediate(r)); },
    onWaiting: async () => {
      if (++calls === 1) throw new Error('GitHub 503');
      const panel = await getReviewApprovals(1, f.deps); assert.equal(panel.requests.length, 1);
      deciding = decideReviewApproval(1, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'once' }, 'operator', f.deps);
    },
  });
  await deciding;
  assert.match(result, /PASS/); assert.equal(calls, 2); assert.equal(f.creates, 1); assert.equal(f.posts, 1);
});

test('deny, terminal failures and local approval waits never become successful reviews', async () => {
  const f = fixture();
  await assert.rejects(runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, sleep: async () => {}, onWaiting: async () => {
    await decideReviewApproval(1, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'deny' }, 'operator', f.deps);
  } }), /INCOMPLETE.*denied/);
  for (const status of ['failed', 'cancelled', 'expired', 'unknown']) {
    f.setCurrent({ run_id: 'run_test', status });
    await assert.rejects(runHermesReview('input', 'instructions', { client: f.client }), /INCOMPLETE/);
  }
  f.setCurrent(waiting);
  const before = f.posts;
  await assert.rejects(runHermesReview('input', 'instructions', { client: f.client }), /authenticated PR check page/);
  assert.equal(f.posts, before);
});

test('stale generation, changed SHA, cross-check request, terminal and replayed decisions are refused', async () => {
  const f = fixture(); f.binding.run_id = 'run_test';
  const decision = { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'once' as const };
  for (const bad of [{ ...decision, execution_generation: 6 }, { ...decision, prompt_id: 'foreign' }, { ...decision, segment: 2 }]) await assert.rejects(decideReviewApproval(1, bad, 'operator', f.deps), /expired|No controllable/);
  await assert.rejects(decideReviewApproval(1, decision, 'operator', { ...f.deps, getPRInfo: async () => ({ head: { sha: 'new-head' } }) } as any), /head changed/);
  await assert.rejects(decideReviewApproval(1, decision, 'operator', { ...f.deps, getCheck: async () => ({ status: 'completed' }) } as any), /no longer active/);
  assert.equal(f.posts, 0);
  const results = await Promise.allSettled([decideReviewApproval(1, decision, 'first', f.deps), decideReviewApproval(1, decision, 'second', f.deps)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.posts, 1); assert.equal(f.decisions.length, 1);
  await assert.rejects(decideReviewApproval(1, decision, 'again', f.deps), /expired|already/);
  assert.equal(f.posts, 1);
});

test('ambiguous decision and credential rotation fail closed without replay', async () => {
  const f = fixture(); f.binding.run_id = 'run_test';
  const decision = { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 7, choice: 'once' as const };
  f.client.decide = async () => { throw new Error('lost acknowledgement'); };
  await assert.rejects(decideReviewApproval(1, decision, 'operator', f.deps), /could not be confirmed/);
  assert.equal(f.binding.denied, true);
  await assert.rejects(decideReviewApproval(1, decision, 'operator', f.deps), /already submitted/);
  f.binding.scope = 'other-credential';
  await assert.rejects(getReviewApprovals(1, f.deps), /requester changed/);
});

test('lost create acknowledgement retries exact durable key; poll failures never create another run', async () => {
  const f = fixture(); const keys: string[] = [];
  f.client.create = async (_i?: any, _s?: any, key?: string) => { keys.push(key!); if (keys.length === 1) throw new Error('lost acknowledgement'); return { run_id: 'run_test', status: 'queued' }; };
  let reads = 0;
  f.client.status = async () => { if (++reads <= 2) throw new Error('offline'); return completed; };
  assert.match(await runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, sleep: async () => {} }), /PASS/);
  assert.deepEqual(keys, ['persisted-key', 'persisted-key']); assert.equal(reads, 3);
  f.client.status = async () => { throw new Error('offline'); };
  await assert.rejects(runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, sleep: async () => {} }), /identity retained/);
  assert.equal(keys.length, 2); // already bound: not even a create retry
  assert.equal(f.binding.run_id, 'run_test');
  await assert.rejects(runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, deadlineMs: 0 }), /Timed out/);
});

test('strict control schema and same-origin JSON CSRF guard', () => {
  assert.equal(validCheckId('1'), true);
  for (const id of ['1x', '0', '-1', '1.5', '2147483648']) assert.equal(validCheckId(id), false);
  const valid = { segment: 1, prompt_id: 'prompt_1', execution_generation: 1, choice: 'once' };
  assert.deepEqual(parseApprovalDecision(valid), valid);
  for (const body of [null, [], { ...valid, choice: 'session' }, { ...valid, choice: 'always' }, { ...valid, choice: 'always_repository' }, { ...valid, run_id: 'foreign' }, { ...valid, execution_generation: '1' }, { ...valid, prompt_id: '../foreign' }]) assert.throws(() => parseApprovalDecision(body), /Invalid decision/);
  for (const headers of [{}, { origin: 'https://evil.example', 'content-type': 'application/json' }, { origin: new URL(APP_BASE_URL).origin, 'content-type': 'text/plain' }]) assert.throws(() => requireApprovalCsrf(new Request(APP_BASE_URL, { method: 'POST', headers: headers as Record<string, string> })), /Same-origin/);
  requireApprovalCsrf(new Request(APP_BASE_URL, { method: 'POST', headers: { origin: new URL(APP_BASE_URL).origin, 'content-type': 'application/json' } }));
});

test('HTTP client preserves requester/profile and sends only exact once/deny control fields', async () => {
  const oldFetch = global.fetch;
  const oldUrl = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_URL = 'http://fixture.invalid/p/test-review';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/capabilities')) return Response.json({ features: { run_submission: true, run_status: true, run_approval_response: true, approval_events: true } });
    if (String(url).endsWith('/approval')) return Response.json({ status: 'resolved' });
    return Response.json(waiting);
  };
  try {
    const client = hermesClient(); assert.equal(await client.supported(), true);
    await client.create('input', 'instructions', 'exact-key'); await client.status('run_test'); await client.decide('run_test', prompt, 'once');
    const auth = (calls[0].init.headers as any).Authorization;
    for (const c of calls) { assert.equal((c.init.headers as any).Authorization, auth); assert.ok(c.url.startsWith('http://fixture.invalid/p/test-review/v1/')); }
    assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), { request_id: 'approval_1', execution_generation: 7, choice: 'once' });
    assert.equal((calls[1].init.headers as any)['Idempotency-Key'], 'exact-key');
    assert.deepEqual(JSON.parse(calls[1].init.body as string), { input: 'input', instructions: 'instructions' });
  } finally { global.fetch = oldFetch; if (oldUrl == null) delete process.env.OPENCLAW_GATEWAY_URL; else process.env.OPENCLAW_GATEWAY_URL = oldUrl; }
});

test('30-minute native approval window is excluded from the 9-minute execution budget, then active work times out', async () => {
  for (const finish of [true, false]) for (const metadata of [{ timeout_s: 1800 }, {}]) {
    const f = fixture(); let clock = 0; let steps = 0;
    f.setCurrent({ ...waiting, pending_controls: [{ ...prompt, ...metadata }] });
    const review = runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1, now: () => clock,
      sleep: async () => {
        if (++steps === 1) clock += 1_200_000; // twenty minutes of real approval waiting
        else if (steps === 2) { clock += 100; f.setCurrent(finish ? completed : { run_id: 'run_test', status: 'running' }); }
        else clock += 540_001;
      },
    });
    if (finish) assert.match(await review, /PASS/);
    else await assert.rejects(review, /Timed out/);
    assert.equal(f.creates, 1); assert.equal(f.posts, 0);
  }
});

test('completed check keeps safe expired approval history and never polls or returns tool data', async () => {
  const f = fixture(); f.binding.denied = true;
  f.binding.history = [{ prompt_id: 'expired1', execution_generation: 7, outcome: 'expired', expiresAt: '2026-10-22T20:15:24.000Z' }];
  f.client.status = async () => { throw new Error('completed history must not need native access'); };
  const data = await getReviewApprovals(1, { ...f.deps, getCheck: async () => ({ status: 'completed' }) } as any);
  assert.equal(data.requests.length, 0); assert.equal(data.history[0].outcome, 'expired'); assert.equal(data.can_restart, true);
  assert.ok(!JSON.stringify(data.history).includes(prompt.command));
  f.binding.history = [];
  assert.equal((await getReviewApprovals(1, { ...f.deps, getCheck: async () => ({ status: 'completed' }) } as any)).legacy_incomplete, true);
});

test('calculated baseline deadlines are stable, approximate and bounded, including missing metadata', () => {
  for (const [metadata, timeout] of [[{}, 1800], [{ timeout_s: 60 }, 60], [{ timeout_s: 9000 }, 1800]] as const) {
    const first = observedApproval({ ...prompt, ...metadata }, undefined, 1000);
    assert.equal(first.app_deadline_at, 1 + timeout);
    assert.equal(first.deadline_approximate, true);
    assert.equal(first.expires_at, undefined, 'never invent a native deadline');
    assert.equal(observedApproval({ ...prompt, ...metadata }, first, 1_200_000).app_deadline_at, first.app_deadline_at);
  }
});

test('a stuck canonical wait without native deadline cannot pause the app forever', async () => {
  const f = fixture(); let clock = 0;
  await assert.rejects(runHermesReview('input', 'instructions', { client: f.client, store: f.store, checkId: 1,
    now: () => clock, sleep: async () => { clock += 600_000; },
  }), /Timed out/);
  assert.equal(clock, 2_400_000);
  assert.equal(f.creates, 1); assert.equal(f.posts, 0);
});

test('client supports baseline Runs without a timeout extension', async () => {
  const saved = global.fetch; let creates = 0;
  global.fetch = async url => {
    if (String(url).endsWith('/runs')) creates++;
    return Response.json({ features: { run_submission: true, run_status: true, run_approval_response: true, approval_events: true } });
  };
  try { assert.equal(await hermesClient().supported(), true); assert.equal(creates, 0); }
  finally { global.fetch = saved; }
});
