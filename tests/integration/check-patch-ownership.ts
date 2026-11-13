// Real runner, GitHub PATCH retry helper, and disposable PostgreSQL ownership.
// Only GitHub transport and reviewer execution are substituted; no live writes.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
process.env.DATABASE_URL = database;
const db = await import('../../lib/db.ts');
const { updateCheck: actualUpdateCheck } = await import('../../lib/github.ts');
const pool = new pg.Pool({ connectionString: database });
after(async () => { await pool.end(); });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
let phase = '', first404 = gate(), injected404 = false;
let creates = 0, reviews = 0, runs = 0;
const patches: any[] = [];
const octokit = { request: async (route: string, params: any) => {
  assert.equal(route, 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}');
  patches.push(params);
  const target = phase === 'initial' ? params.status === 'in_progress' && !params.output
    : phase === 'waiting' ? params.output?.title === 'Tool approval required'
    : params.status === 'completed';
  if (target && !injected404) {
    injected404 = true;
    first404.release();
    throw Object.assign(new Error('Not Found'), { status: 404 });
  }
  return { data: { id: params.check_run_id } };
} };
mock.module('../../lib/github.ts', { namedExports: {
  getInstallationOctokit: async () => octokit, fetchPRCheckFiles: async () => [],
  getPRInfo: async () => ({ state: 'open', title: 'Fixture', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } }),
  getPRDiff: async () => 'diff', createCheck: async () => ({ id: ++creates }),
  updateCheck: actualUpdateCheck,
  createPRReview: async () => { reviews++; },
} });
mock.module('../../lib/llm.ts', { namedExports: {
  callOpenClaw: async (_prompt: string, _context: string, options: any) => {
    runs++;
    if (phase === 'waiting') await options.onWaiting();
    if (phase === 'error') throw new Error('fixture reviewer failed');
    return { success: true, response: 'VERDICT: PASS\nPRIVATE_DIAGNOSTIC' };
  },
} });
const { dispatchReviewRestart } = await import('../../lib/review-restart.ts');

test('real PATCH retries stop when PostgreSQL owner dies during 404 backoff, across all runner paths', { timeout: 15000 }, async () => {
  await db.initDatabase();
  await db.upsertRepo('fixture/patch-owner', 1, true);
  for (const scenario of ['success', 'initial', 'waiting', 'error']) {
    phase = scenario; first404 = gate(); injected404 = false;
    const source = await db.insertCheckRun({ repo: 'fixture/patch-owner', pr_number: 345,
      check_name: 'Code Review', check_identity: 'global:code-review', head_sha: 'a'.repeat(40) });
    await db.updateCheckRun(source, { status: 'completed', conclusion: 'failure' });
    const target = await db.reserveReviewRestart(source, 'fixture', async () => {});
    const before = [creates, reviews, runs];
    const running = dispatchReviewRestart(source).then(() => null, error => error);
    try {
      await Promise.race([first404.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no first PATCH404: ${scenario}`)), 3000))]);
      // The helper has thrown out of transport and entered its actual backoff.
      await new Promise(r => setTimeout(r, 20));
      const owner = (await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=165 AND objid=$1 AND granted", [source])).rows[0];
      assert.ok(owner);
      await pool.query('SELECT pg_terminate_backend($1)', [owner.pid]);
      await db.reconcileReviewRestarts();
      const settled = await db.getCheckRun(target);
      assert.equal(settled?.status, 'completed');
      assert.equal(settled?.conclusion, 'failure');
      assert.match(settled?.summary ?? '', /INCOMPLETE/);
      const published = [patches.length, creates, reviews, runs];
      assert.ok(await running, 'dispatch must reject after owner loss');
      assert.deepEqual(await db.getCheckRun(target), settled, scenario);
      await db.reconcileReviewRestarts();
      await dispatchReviewRestart(source);
      assert.deepEqual([patches.length, creates, reviews, runs], published, `zero subsequent PATCH or replay: ${scenario}`);
      assert.equal(creates, before[0] + 1);
      assert.equal(reviews - before[1], scenario === 'success' ? 1 : 0);
      assert.equal(runs - before[2], scenario === 'initial' ? 0 : 1);
    } finally { await running; }
  }
});
