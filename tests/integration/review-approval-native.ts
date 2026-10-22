// Opt-in cross-language proof. Uses real native HTTP/SQLite/approval waiter and
// real jean-ci PR runner/PostgreSQL. Only the LLM and GitHub boundaries are fixtures.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
const source = process.env.HERMES_APPROVAL_NATIVE_SOURCE;
const python = process.env.HERMES_APPROVAL_NATIVE_PYTHON;
if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
if (!source?.startsWith('/') || !python?.startsWith('/') || !process.env.TMPDIR) throw new Error('Explicit isolated native checkout, test interpreter, and TMPDIR required');
process.env.DATABASE_URL = database;
process.env.OPENCLAW_USE_WEBSOCKET = 'false';
process.env.OPENCLAW_USE_RUNS = 'true';
process.env.GITHUB_APP_ID = '123';
delete process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL;
const head = 'a'.repeat(40);
const comments: any[] = [];
const octokit = { request: async (route: string, params: any) => {
  assert.equal(params.owner, 'fixture'); assert.equal(params.repo, 'native');
  if (route.startsWith('POST')) {
    const comment = { id: comments.length + 1, body: params.body, performed_via_github_app: { id: 123 } };
    comments.push(comment); return { data: comment };
  }
  return { data: comments.find(c => c.id === params.comment_id) };
} };
let nextCheck = 0;
mock.module(new URL('../../lib/github.ts', import.meta.url).href, { namedExports: {
  getInstallationOctokit: async () => octokit, fetchPRCheckFiles: async () => [],
  getPRInfo: async () => ({ title: 'Native approval proof', state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40) } }),
  getPRDiff: async () => 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  createCheck: async () => ({ id: ++nextCheck }), updateCheck: async () => {}, createPRReview: async () => {},
} });

test('real PR runner -> native Runs -> real blocking waiter: once/deny/expiry retain exact run and never bypass', { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(process.env.TMPDIR!, 'jean-native-approval-'));
  const child = spawn(python!, [new URL('./native-approval-fixture.py', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: home, HERMES_HOME: home, HERMES_RUNTIME_DIR: join(home, 'runtime'), TMPDIR: home, PYTHONPATH: source! },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  t.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  child.stderr.on('data', b => { logs += b; });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`Native fixture startup timed out: ${logs}`)), 20_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native fixture exited ${code}: ${logs}`)); });
      child.stdout.on('data', b => {
        text += b;
        for (const line of text.split('\n')) {
          try { const value = JSON.parse(line); if (Number.isInteger(value.port)) { clearTimeout(timer); resolve(value.port); } } catch { /* native startup logs may be plain text */ }
        }
      });
    });
    const gateway = `http://127.0.0.1:${port}`;
    process.env.OPENCLAW_GATEWAY_URL = gateway;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'native-fixture-only';
    const db = await import('../../lib/db.ts');
    const { runPRReview } = await import('../../lib/pr-review.ts');
    const { getReviewApprovals, decideReviewApproval } = await import('../../lib/review-approvals.ts');
    const { hermesClient } = await import('../../lib/hermes-runs.ts');
    await db.initDatabase();
    await db.upsertRepo('fixture/native', 1, true);
    const client = hermesClient();
    assert.equal(await client.supported(), true, 'native negotiates the exact per-run window capability');
    for (const mode of ['once', 'deny', 'expiry']) {
      const running = runPRReview(1, 'fixture', 'native', 1, head);
      let id: number | undefined;
      for (let i = 0; i < 1000; i++) {
        const checks = await db.getAllCheckRuns(1);
        id = checks[0]?.id;
        if (id && (await db.reviewRunStore.get(id))[0]?.pending.length) break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(id);
      const before = (await db.reviewRunStore.get(id))[0];
      assert.ok(before?.run_id); assert.equal(before.pending.length, 1);
      const native = await client.status(before.run_id!);
      assert.equal(native.status, 'waiting_for_approval');
      assert.equal(native.pending_controls![0].timeout_s, 1800);
      assert.ok(native.pending_controls![0].expires_at! * 1000 - Date.now() > 1_790_000);
      const panels = await Promise.all([getReviewApprovals(id), getReviewApprovals(id)]);
      assert.equal(panels[0].requests[0].prompt_id, panels[1].requests[0].prompt_id);
      assert.equal((await fetch(`${gateway}/_fixture/evidence`).then(r => r.json()))[before.run_id!], undefined, 'native waiter has not been answered by polling or a link');
      const decision = { segment: 1, prompt_id: before.pending[0].prompt_id, execution_generation: before.pending[0].execution_generation, choice: mode === 'deny' ? 'deny' as const : 'once' as const };
      if (mode === 'expiry') {
        const expired = await fetch(`${gateway}/_fixture/expire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: before.run_id }) });
        assert.deepEqual(await expired.json(), { advanced: 1, resolved: 0 });
      } else await decideReviewApproval(id, decision, 'fixture-admin');
      await running;
      const binding = (await db.reviewRunStore.get(id))[0];
      assert.equal(binding.run_id, before.run_id, 'exact live run retained through native completion');
      const outcome = await fetch(`${gateway}/_fixture/evidence`).then(r => r.json());
      assert.deepEqual(outcome[before.run_id!], mode === 'expiry' ? { resolved: false, choice: null } : { resolved: true, choice: mode });
      assert.equal((await db.getCheckRun(id))?.conclusion, mode === 'once' ? 'success' : 'failure');
      assert.equal(binding.denied, mode !== 'once');
      await assert.rejects(decideReviewApproval(id, decision, 'replay'), /no longer active/);
      const completed = await getReviewApprovals(id);
      assert.equal(completed.requests.length, 0); assert.equal(completed.history.length, 1);
      assert.ok(!JSON.stringify(completed.history).includes('fixture required source read'));
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', () => resolve()); });
    await rm(home, { recursive: true, force: true });
  }
});
