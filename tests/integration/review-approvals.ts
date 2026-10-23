// Run only against an explicitly provisioned disposable local PostgreSQL:
// REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://... npm run test:approvals:integration
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
process.env.DATABASE_URL = database;
process.env.OPENCLAW_GATEWAY_URL = 'http://hermes-fixture.invalid';
process.env.OPENCLAW_GATEWAY_TOKEN = 'fixture-only';
process.env.OPENCLAW_USE_WEBSOCKET = 'false';
process.env.OPENCLAW_USE_RUNS = 'true';
process.env.GITHUB_APP_ID = '123';
delete process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL;
const db = await import('../../lib/db.ts');
const { hermesClient } = await import('../../lib/hermes-runs.ts');
const pool = new pg.Pool({ connectionString: database });
after(async () => { await pool.end(); });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
let waitStatusFailures = 0;
let ackGate: ReturnType<typeof gate> | null = null;
let settledRead: ReturnType<typeof gate> | null = null;
const originalGet = db.reviewRunStore.get;
db.reviewRunStore.get = async check => {
  const rows = await originalGet(check);
  if (rows.some(r => r.status === 'completed' && r.settling)) settledRead?.release();
  return rows;
};
const updates: any[] = [];
const reviews: any[] = [];
const comments: any[] = [];
const githubRequests: string[] = [];
const githubFixture = { request: async (route: string, params: any) => {
  githubRequests.push(route);
  if (route.startsWith('POST')) {
    assert.equal(params.owner, 'fixture'); assert.equal(params.repo, 'repo'); assert.equal(params.issue_number, 1);
    const comment = { id: comments.length + 1, body: params.body, performed_via_github_app: { id: 123 } };
    comments.push(comment); return { data: comment };
  }
  if (route.includes('/issues/comments/')) return { data: comments.find(c => c.id === params.comment_id) };
  return { data: comments };
} };
let currentHead = 'a'.repeat(40);
let currentState = 'open';
let customFiles: Array<{ name: string; path: string; content: string }> = [];
let nextCheck = 100;
let githubCreateFailure: 'before' | 'ambiguous' | null = null;
let githubCompletion: { entered: ReturnType<typeof gate>; response: ReturnType<typeof gate>; reject: boolean } | null = null;
const moduleUrl = (name: string) => new URL(`../../lib/${name}.ts`, import.meta.url).href;
mock.module(moduleUrl('github'), { namedExports: {
  getInstallationOctokit: async () => githubFixture, fetchPRCheckFiles: async () => customFiles,
  getPRInfo: async () => ({ title: 'CSRF context fixture', head: { sha: currentHead }, base: { sha: 'b'.repeat(40) }, state: currentState }),
  getPRDiff: async () => 'diff --git a/auth.ts b/auth.ts\n@@ -1 +1 @@\n-old\n+new\n',
  createCheck: async () => {
    if (githubCreateFailure === 'before') throw new Error('GitHub unavailable before creation');
    const id = ++nextCheck;
    if (githubCreateFailure === 'ambiguous') throw new Error('GitHub created check but acknowledgement lost');
    return { id };
  }, updateCheck: async (...args: any[]) => { const payload = args.at(-1);
    if (payload.output?.title === 'Tool approval required' && waitStatusFailures > 0) { waitStatusFailures--; throw new Error('GitHub 503'); }
    updates.push(payload);
    if (payload.status === 'completed' && githubCompletion) {
      const completion = githubCompletion;
      completion.entered.release();
      await completion.response.promise;
      if (completion.reject) throw new Error('GitHub completion acknowledgement lost');
    }
  },
  createPRReview: async (...args: any[]) => { reviews.push(args); },
} });
const { runPRReview } = await import('../../lib/pr-review.ts');
const { decideReviewApproval, getReviewApprovals, notifyReviewApproval } = await import('../../lib/review-approvals.ts');
const { recoverInterruptedChecks } = await import('../../lib/interrupted-check-recovery.ts');
let createCount = 0;
let approvalPosts = 0;
let mode = 'once';
let current: any;
const keys = new Map<string, string>();
let lost = false;
const prompt = { kind: 'approval', prompt_id: 'approval_native_shape', execution_generation: 11, command: 'python inspect_csrf.py', description: 'Read required source context', choices: ['once', 'deny', 'session', 'always'] };
const oldFetch = global.fetch;
const fixtureFetch: typeof fetch = async (url, init = {}) => {
  const path = String(url);
  assert.ok(path.startsWith('http://hermes-fixture.invalid/v1/'), 'no live network requests');
  if (path.endsWith('/capabilities')) return Response.json({ features: { run_submission: true, run_status: true, run_approval_response: true, approval_events: true } });
  if (path.endsWith('/runs') && init.method === 'POST') {
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    assert.ok(key);
    if (!keys.has(key)) {
      createCount++;
      const id = `run_integration_${createCount}`;
      keys.set(key, id);
      current = { run_id: id, status: 'waiting_for_approval', execution_generation: 11, pending_controls: [prompt] };
    }
    if (mode === 'lost-create' && !lost) { lost = true; throw new Error('lost create acknowledgement'); }
    return Response.json({ run_id: keys.get(key), status: 'queued' }, { status: 202 });
  }
  if (path.endsWith('/approval')) {
    approvalPosts++;
    assert.deepEqual(JSON.parse(init.body as string), { request_id: prompt.prompt_id, execution_generation: 11, choice: mode === 'deny' ? 'deny' : 'once' });
    current = { ...current, status: 'completed', pending_controls: [], output: 'VERDICT: PASS\nNo blocking defects.\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.' };
    if (mode === 'delayed-ack') await ackGate!.promise;
    return Response.json({ status: 'resolved', prompt_id: prompt.prompt_id });
  }
  return Response.json(current);
};
global.fetch = fixtureFetch;

test('actual PR runner + PostgreSQL: once resumes, deny/expiry incomplete, no autoapproval or duplicate runs', async () => {
  try {
    await db.initDatabase(); await db.initDatabase();
    await pool.query('TRUNCATE jean_ci_check_runs CASCADE');
    await db.upsertRepo('fixture/repo', 1, true);
    for (const selected of ['once', 'deny', 'expiry', 'lost-create', 'delayed-ack', 'github-503']) {
      mode = selected; updates.length = 0; reviews.length = 0;
      waitStatusFailures = selected === 'github-503' ? 1 : 0;
      ackGate = gate(); settledRead = gate();
      const before = createCount; const postsBefore = approvalPosts;
      const commentsBefore = comments.length;
      const running = runPRReview(1, 'fixture', 'repo', 1, currentHead);
      let checkId: number | undefined;
      // Wait for the durable native prompt, not for a transient in-memory callback.
      for (let i = 0; i < 100; i++) {
        const checks = await db.getAllCheckRuns(1);
        checkId = checks[0]?.id;
        if (checkId && (await db.reviewRunStore.get(checkId))[0]?.pending.length && comments.length > commentsBefore
          && updates.some(u => u.output?.title === 'Tool approval required')) break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(checkId);
      assert.equal(approvalPosts, postsBefore, 'runner never approves automatically');
      const waitingUpdate = updates.find(u => u.output?.title === 'Tool approval required');
      assert.equal(waitingUpdate?.status, 'in_progress');
      assert.match(waitingUpdate.output.summary, /authenticated check page/);
      assert.ok(!waitingUpdate.output.summary.includes(prompt.command));
      assert.equal(reviews.length, 0, 'waiting never requests changes');
      const panel = await getReviewApprovals(checkId);
      assert.equal(panel.requests[0].prompt_id, prompt.prompt_id);
      if (selected === 'expiry') {
        current = { ...current, status: 'completed', pending_controls: [], output: 'VERDICT: PASS\nNo defects.' };
      } else {
        const deciding = decideReviewApproval(checkId, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 11, choice: selected === 'deny' ? 'deny' : 'once' }, 'test-admin:operator');
        if (selected === 'delayed-ack') {
          await Promise.race([settledRead!.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('worker never observed in-flight completion')), 5000))]);
          assert.notEqual((await db.getCheckRun(checkId))?.status, 'completed');
          const pending = (await db.reviewRunStore.get(checkId))[0];
          assert.equal(pending.settling, true); assert.equal(pending.denied, false);
          ackGate!.release();
        }
        await deciding;
      }
      await running;
      const commentAudit = await pool.query('SELECT comment_id,comment_url FROM jean_ci_review_approval_comments WHERE check_id=$1', [checkId]);
      assert.equal(commentAudit.rowCount, 1);
      assert.ok(commentAudit.rows[0].comment_id, 'comment verified by exact GET before persisted delivery');
      assert.equal(comments.length - commentsBefore, 1);
      assert.ok(comments.at(-1).body.includes(`/checks/${checkId})`));
      assert.ok(!comments.at(-1).body.includes(prompt.command));
      assert.equal(createCount - before, 1, 'same run throughout including lost create acknowledgement');
      const saved = await db.getCheckRun(checkId);
      const bindings = await db.reviewRunStore.get(checkId);
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].run_id, current.run_id);
      assert.equal(saved?.status, 'completed');
      if (selected === 'deny' || selected === 'expiry') {
        assert.equal(reviews.length, 0);
        assert.equal(saved?.conclusion, 'failure');
        assert.match(saved?.summary || '', /INCOMPLETE/);
        assert.equal(bindings[0].denied, true);
      } else {
        assert.equal(saved?.conclusion, 'success');
        assert.equal(reviews.length, 1); assert.equal(reviews[0][4], 'APPROVE');
        const audit = await pool.query('SELECT * FROM jean_ci_review_decisions WHERE check_id=$1', [checkId]);
        assert.equal(audit.rowCount, 1); assert.equal(audit.rows[0].actor, 'test-admin:operator'); assert.equal(audit.rows[0].outcome, 'accepted');
      }
      await assert.rejects(decideReviewApproval(checkId, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 11, choice: 'once' }, 'replay'), /no longer active/);
    }
  } finally { global.fetch = oldFetch; }
});

test('PostgreSQL locks fetch + observation across worker and browser, preventing reversed responses', async () => {
  const { runHermesReview } = await import('../../lib/hermes-runs.ts');
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'ordered', head_sha: currentHead });
  const oldFetched = gate(), releaseOld = gate(), workerSleep = gate(), sleeping = gate();
  let calls = 0;
  const waiting = { run_id: 'run_ordered', status: 'waiting_for_approval', execution_generation: 11, pending_controls: [{ ...prompt, kind: 'approval' as const }] };
  let native = waiting;
  const client = { ...hermesClient(), scope: 'ordered-scope', create: async () => ({ run_id: 'run_ordered', status: 'queued' }), status: async () => {
    calls++;
    if (calls === 1) { oldFetched.release(); await releaseOld.promise; return { run_id: 'run_ordered', status: 'running', pending_controls: [] }; }
    return structuredClone(native);
  } };
  const running = runHermesReview('ordered', 'instructions', { client, store: db.reviewRunStore, checkId: id,
    sleep: async () => { sleeping.release(); await workerSleep.promise; } });
  await oldFetched.promise;
  const browser = getReviewApprovals(id, { store: db.reviewRunStore, client: () => client, getCheck: db.getCheckRun } as any);
  // Wait for the second transaction to actually block, not an arbitrary sleep.
  let blocked = false;
  for (let i = 0; i < 100; i++) {
    const locks = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM jean_ci_review_runs%'");
    if (locks.rowCount) { blocked = true; break; }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(blocked, true); assert.equal(calls, 1, 'browser fetch must not run outside row lock');
  releaseOld.release();
  const panel = await browser; await sleeping.promise;
  assert.equal(panel.requests[0].prompt_id, prompt.prompt_id);
  let saved = (await db.reviewRunStore.get(id))[0];
  assert.equal(saved.denied, false); assert.equal(saved.pending.length, 1);
  assert.equal(await db.claimReviewDecision(saved, waiting.pending_controls[0], 'once', 'operator'), true);
  await db.finishReviewDecision(saved, waiting.pending_controls[0], 'accepted', 'once');
  native = { ...waiting, status: 'completed', pending_controls: [], output: 'VERDICT: PASS' } as typeof waiting;
  workerSleep.release();
  assert.match(await running, /PASS/);
  saved = (await db.reviewRunStore.get(id))[0];
  assert.equal(saved.denied, false); assert.equal(saved.status, 'completed'); assert.equal(saved.pending.length, 0);
});

test('PostgreSQL atomic claims, durable identity, scope binding, expiry and restart fail closed', async () => {
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'restart', head_sha: currentHead });
  await db.setCheckRunGithubId(id, 999);
  const client = hermesClient();
  const reservations = await Promise.all(Array.from({ length: 8 }, () => db.reviewRunStore.reserve(id, 1, client.scope, 'payload')));
  assert.equal(new Set(reservations.map(r => r.request_key)).size, 1);
  await assert.rejects(db.reviewRunStore.reserve(id, 1, 'foreign', 'payload'), /requester or payload changed/);
  await assert.rejects(db.reviewRunStore.reserve(id, 1, client.scope, 'different'), /requester or payload changed/);
  await db.reviewRunStore.bind(id, 1, 'run_restart');
  const binding = (await db.reviewRunStore.get(id))[0];
  const p = { ...prompt, kind: 'approval' as const };
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => db.claimReviewDecision(binding, p, 'once', `admin-${i}`)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await db.reviewRunStore.get(id))[0].settling, true, 'live dispatch is not a denial');
  await pool.query("UPDATE jean_ci_review_decisions SET created_at=NOW()-INTERVAL '61 seconds' WHERE check_id=$1", [id]);
  assert.equal((await db.reviewRunStore.get(id))[0].denied, true, 'expired dispatch after crash is incomplete');
  await assert.rejects(db.finishReviewDecision(binding, p, 'accepted', 'once'), /lease expired/);
  assert.equal((await pool.query('SELECT outcome FROM jean_ci_review_decisions WHERE check_id=$1', [id])).rows[0].outcome, 'uncertain');
  const notifications = await Promise.all(Array.from({ length: 8 }, () => db.claimReviewNotification(id, 'exact-prompt')));
  assert.equal(notifications.filter(Boolean).length, 1, 'notification dedupe is durable');
  const commentClaims = await Promise.all(Array.from({ length: 8 }, () => db.claimApprovalComment(id, 'request-identity')));
  assert.equal(commentClaims.filter(Boolean).length, 1, 'comment delivery lease is atomic');
  const claimedComment = commentClaims.find(Boolean)!;
  await db.updateApprovalComment(claimedComment, { uncertain: true, candidateId: 123 });
  await pool.query("UPDATE jean_ci_review_approval_comments SET lease_until=NOW()-INTERVAL '1 second' WHERE check_id=$1", [id]);
  const resumedComment = await db.claimApprovalComment(id, 'request-identity');
  assert.equal(resumedComment?.marker, claimedComment.marker);
  assert.equal(resumedComment?.uncertain, true);
  assert.equal(String(resumedComment?.candidate_id), '123');
  await db.updateApprovalComment(resumedComment!, { uncertain: false, commentId: 123, url: 'https://github.com/fixture/repo/pull/1#issuecomment-123' });
  assert.equal(await db.claimApprovalComment(id, 'request-identity'), null);
  const check = await db.getCheckRun(id);
  const result = await recoverInterruptedChecks({
    listInterruptedChecks: async () => [check!], getRepo: db.getRepo, getInstallationOctokit: async () => ({}),
    getGitHubCheck: async () => ({ status: 'in_progress' }), completeGitHubCheck: async () => {}, markCheckCompleted: db.updateCheckRun,
    detailsUrl: i => `http://localhost/checks/${i}`,
  });
  assert.equal(result.recovered, 1);
  assert.equal((await db.getCheckRun(id))?.conclusion, 'neutral');
  assert.equal((await db.reviewRunStore.get(id))[0].run_id, 'run_restart', 'restart retains identity without creating a review');
  await assert.rejects(decideReviewApproval(id, { segment: 1, prompt_id: p.prompt_id, execution_generation: 11, choice: 'once' }, 'operator'), /no longer active/);
});

test('optional Discord notice is safe, read back, durably deduplicated, and absent without configured webhook', async () => {
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Discord fixture', head_sha: currentHead });
  const binding = await db.reviewRunStore.reserve(id, 1, hermesClient().scope, 'discord');
  await db.reviewRunStore.bind(id, 1, 'run_discord_fixture');
  await db.reviewRunStore.observe({ ...binding, run_id: 'run_discord_fixture' }, async () => ({ run_id: 'run_discord_fixture', status: 'waiting_for_approval', execution_generation: 11, pending_controls: [{ ...prompt, kind: 'approval' as const }] }));
  let calls = 0; let content = '';
  global.fetch = async (url, init = {}) => {
    calls++;
    assert.ok(String(url).startsWith('https://discord.com/api/webhooks/fixture/test-only'));
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      content = body.content;
      assert.ok(content.includes(`/checks/${id}`));
      assert.ok(!content.includes(prompt.command));
      assert.ok(!content.includes('test-only'));
      return Response.json({ id: '54321' });
    }
    assert.ok(String(url).includes('/messages/54321'));
    return Response.json({ id: '54321', content });
  };
  try {
    delete process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL;
    await notifyReviewApproval(id); assert.equal(calls, 0);
    process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL = 'https://untrusted.invalid/webhook';
    await notifyReviewApproval(id); assert.equal(calls, 0);
    process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/fixture/test-only';
    await notifyReviewApproval(id); assert.equal(calls, 2);
    await notifyReviewApproval(id); assert.equal(calls, 2);
  } finally { delete process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL; global.fetch = oldFetch; }
});

test('expired-check restart is durable and deduplicated across concurrent clicks and dispatchers; stale head/closed/disabled/live refuse', async () => {
  const { restartReview, dispatchReviewRestart } = await import('../../lib/review-restart.ts');
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Code Review', head_sha: currentHead });
  let b = await db.reviewRunStore.reserve(id, 1, hermesClient().scope, 'expired-source');
  await db.reviewRunStore.bind(id, 1, 'run_expired_restart'); b = { ...b, run_id: 'run_expired_restart' };
  const p = { ...prompt, kind: 'approval' as const, expires_at: Date.now() / 1000 - 1, timeout_s: 1800 };
  await db.reviewRunStore.observe(b, async () => ({ run_id: b.run_id!, status: 'waiting_for_approval', execution_generation: 11, pending_controls: [p] }));
  await db.reviewRunStore.observe(b, async () => ({ run_id: b.run_id!, status: 'completed', output: 'INCOMPLETE', pending_controls: [] }));
  await db.updateCheckRun(id, { status: 'completed', conclusion: 'failure' });
  const history = await getReviewApprovals(id);
  assert.equal(history.history[0].outcome, 'expired'); assert.equal(history.requests.length, 0); assert.equal(history.can_restart, true);
  assert.ok(!JSON.stringify(history).includes(p.command));
  let originalStatus = 'completed';
  global.fetch = async (url, init = {}) => String(url).endsWith('/run_expired_restart') ? Response.json({ run_id: 'run_expired_restart', status: originalStatus, pending_controls: [] }) : fixtureFetch(url, init);
  try {
    currentState = 'closed'; await assert.rejects(restartReview(id, 'operator'), /PR closed/); currentState = 'open';
    currentHead = 'c'.repeat(40); await assert.rejects(restartReview(id, 'operator'), /head changed/); currentHead = 'a'.repeat(40);
    await db.setRepoReviewEnabled('fixture/repo', false); await assert.rejects(restartReview(id, 'operator'), /disabled/); await db.setRepoReviewEnabled('fixture/repo', true);
    for (const status of ['running', 'unknown']) { originalStatus = status; await assert.rejects(restartReview(id, 'operator'), /still live or unknown/); } originalStatus = 'completed';
    const before = createCount; const posts = approvalPosts; const checkBefore = nextCheck;
    const results = await Promise.all(Array.from({ length: 12 }, () => restartReview(id, 'operator')));
    assert.equal(new Set(results.map(r => r.check_id)).size, 1);
    const newId = results[0].check_id;
    assert.notEqual(newId, id); assert.equal((await db.getCheckRun(id))?.status, 'completed');
    assert.equal(createCount, before, 'link/POST reservation never auto-approves or starts an unreserved run');
    mode = 'once';
    const dispatches = Array.from({ length: 8 }, () => dispatchReviewRestart(id));
    for (let i = 0; i < 200 && !(await db.reviewRunStore.get(newId))[0]?.pending.length; i++) await new Promise(r => setTimeout(r, 10));
    const newBinding = (await db.reviewRunStore.get(newId))[0];
    assert.ok(newBinding?.pending.length); assert.equal(createCount, before + 1); assert.equal(nextCheck, checkBefore + 1);
    assert.equal(approvalPosts, posts, 'explicit restart must still wait for a separate approval');
    await decideReviewApproval(newId, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 11, choice: 'once' }, 'operator');
    await Promise.all(dispatches);
    assert.equal((await db.getCheckRun(newId))?.conclusion, 'success');
    assert.ok((await db.getCheckRun(newId))?.prompt); assert.equal((await db.getCheckRun(newId))?.pr_title, 'CSRF context fixture');
    const repeated = await restartReview(id, 'operator'); assert.equal(repeated.check_id, newId);
    await dispatchReviewRestart(id); assert.equal(createCount, before + 1);
    assert.equal((await pool.query('SELECT * FROM jean_ci_review_restarts WHERE source_check_id=$1', [id])).rowCount, 1);
  } finally { currentState = 'open'; currentHead = 'a'.repeat(40); global.fetch = oldFetch; }
});

async function reservedRestart() {
  const source = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Code Review', head_sha: currentHead });
  await db.updateCheckRun(source, { status: 'completed', conclusion: 'failure', title: 'Review restart interrupted', summary: 'INCOMPLETE: Previous restart did not finish.' });
  const target = await db.reserveReviewRestart(source, 'operator', async () => {});
  return { source, target };
}
async function assertInterrupted(source: number, target: number) {
  const check = await db.getCheckRun(target);
  assert.equal(check?.status, 'completed'); assert.equal(check?.conclusion, 'failure');
  assert.equal(check?.title, 'Review restart interrupted'); assert.match(check?.summary || '', /^INCOMPLETE:/);
  assert.ok(check?.completed_at);
  assert.equal((await pool.query('SELECT dispatch_status FROM jean_ci_review_restarts WHERE source_check_id=$1', [source])).rows[0].dispatch_status, 'done');
  assert.equal(await db.claimReviewRestart(source), null);
  assert.equal(await db.reserveReviewRestart(source, 'operator', async () => {}), target, 'source dedup mapping survives reconciliation');
}

test('committed claim crash before check read and before GitHub ID reconciles atomically without replay', async () => {
  const { source, target } = await reservedRestart();
  // Reproduce the old committed-claim/getCheckRun crash gap in a separate process.
  // No check read or GitHub request is made after the committed UPDATE.
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import pg from 'pg';
    const c = new pg.Client({ connectionString: process.env.REVIEW_APPROVAL_TEST_DATABASE_URL });
    await c.connect();
    await c.query("UPDATE jean_ci_review_restarts SET dispatch_status='dispatching',dispatch_started_at=NOW(),dispatch_fenced=TRUE WHERE source_check_id=$1", [${source}]);
    process.exit(73);
  `], { env: process.env, encoding: 'utf8' });
  assert.equal(crash.status, 73, crash.stderr);
  assert.equal((await db.getCheckRun(target))?.github_check_id, null);
  const startup = (await pool.query("SELECT clock_timestamp()+INTERVAL '1 second' AS at")).rows[0].at;
  const counts = [createCount, nextCheck, approvalPosts, reviews.length];
  await db.reconcileReviewRestarts(startup);
  await assertInterrupted(source, target);
  await db.reconcileReviewRestarts(startup);
  const { restartReview, dispatchReviewRestart } = await import('../../lib/review-restart.ts');
  await dispatchReviewRestart(source);
  assert.deepEqual(await restartReview(source, 'operator'), { status: 'completed', check_id: target, url: `/checks/${target}` });
  assert.deepEqual([createCount, nextCheck, approvalPosts, reviews.length], counts);
  assert.equal((await getReviewApprovals(target)).can_restart, true);
  // A separate explicit restart of the terminal target is allowed, but all
  // current-head, repository and known-terminal native-run checks still apply.
  currentState = 'closed'; await assert.rejects(restartReview(target, 'operator'), /PR closed/); currentState = 'open';
  currentHead = 'c'.repeat(40); await assert.rejects(restartReview(target, 'operator'), /head changed/); currentHead = 'a'.repeat(40);
  await db.setRepoReviewEnabled('fixture/repo', false); await assert.rejects(restartReview(target, 'operator'), /disabled/); await db.setRepoReviewEnabled('fixture/repo', true);
  const later = await restartReview(target, 'operator'); assert.notEqual(later.check_id, target);
  assert.equal((await restartReview(target, 'operator')).check_id, later.check_id);
  const binding = await db.reviewRunStore.reserve(later.check_id, 1, hermesClient().scope, 'uncertain-create');
  await db.updateCheckRun(later.check_id, { status: 'completed', conclusion: 'failure', title: 'Review restart interrupted', summary: 'INCOMPLETE: fixture' });
  await assert.rejects(restartReview(later.check_id, 'operator'), /cannot be verified/);
  await db.reviewRunStore.bind(later.check_id, 1, 'run_uncertain_restart');
  global.fetch = async () => Response.json({ run_id: 'run_uncertain_restart', status: 'unknown', pending_controls: [] });
  try { await assert.rejects(restartReview(later.check_id, 'operator'), /live or unknown/); }
  finally { global.fetch = oldFetch; }
  assert.ok(binding);
});

test('abrupt process death with new claim before GitHub ID and after an acknowledged external creation never replays', { timeout: 15_000 }, async () => {
  let externalCreates = 0;
  const remote = createServer((req, res) => {
    assert.equal(req.method, 'POST');
    externalCreates++;
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: externalCreates }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const afterCreation of [false, true]) {
      const { source, target } = await reservedRestart();
      const before = externalCreates;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        const db = await import(${JSON.stringify(moduleUrl('db'))});
        const check = await db.claimReviewRestart(${source});
        if (!check) process.exit(2);
        ${afterCreation ? `const r = await fetch('http://127.0.0.1:${address.port}/checks', { method: 'POST' });
        if (r.status !== 201) process.exit(3); await r.json();` : ''}
        // Terminate without saving the external ID or executing finally cleanup.
        process.exit(74);
      `], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 74, stderr);
      assert.equal(externalCreates, before + Number(afterCreation));
      assert.equal((await db.getCheckRun(target))?.github_check_id, null);
      const startup = (await pool.query("SELECT clock_timestamp()+INTERVAL '1 second' AS at")).rows[0].at;
      await db.reconcileReviewRestarts(startup); await assertInterrupted(source, target);
      const { dispatchReviewRestart } = await import('../../lib/review-restart.ts');
      await dispatchReviewRestart(source); await db.reconcileReviewRestarts(startup);
      assert.equal(externalCreates, before + Number(afterCreation), 'uncertain external creation is not repeated');
      assert.equal((await db.reviewRunStore.get(target)).length, 0, 'no native run was submitted');
    }
  } finally { await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
});

test('new claim is atomic on SQL failure; terminalization failure rolls back settlement and startup retries it', async () => {
  const { source, target } = await reservedRestart();
  await pool.query(`CREATE FUNCTION fixture_fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_check_id=${source} AND NEW.dispatch_status='dispatching' THEN RAISE EXCEPTION 'claim read failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fixture_fail_claim AFTER UPDATE ON jean_ci_review_restarts FOR EACH ROW EXECUTE FUNCTION fixture_fail_claim()`);
  try { await assert.rejects(db.claimReviewRestart(source), /claim read failure/); }
  finally { await pool.query('DROP TRIGGER fixture_fail_claim ON jean_ci_review_restarts; DROP FUNCTION fixture_fail_claim()'); }
  const row = (await pool.query('SELECT * FROM jean_ci_review_restarts WHERE source_check_id=$1', [source])).rows[0];
  assert.equal(row.dispatch_status, 'queued'); assert.equal(row.dispatch_started_at, null);
  assert.equal((await db.claimReviewRestart(source))?.id, target);
  assert.equal(await db.claimReviewRestart(source), null);
  await pool.query(`CREATE FUNCTION fixture_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id=${target} AND NEW.status='completed' THEN RAISE EXCEPTION 'terminal persistence failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fixture_fail_terminal BEFORE UPDATE ON jean_ci_check_runs FOR EACH ROW EXECUTE FUNCTION fixture_fail_terminal()`);
  const startup = (await pool.query("SELECT clock_timestamp()+INTERVAL '1 second' AS at")).rows[0].at;
  try {
    await assert.rejects(db.finishReviewRestart(source), /terminal persistence failure/);
    await assert.rejects(db.reconcileReviewRestarts(startup), /terminal persistence failure/);
    assert.equal((await pool.query('SELECT dispatch_status FROM jean_ci_review_restarts WHERE source_check_id=$1', [source])).rows[0].dispatch_status, 'dispatching');
    assert.equal((await db.getCheckRun(target))?.status, 'queued');
  } finally { await pool.query('DROP TRIGGER fixture_fail_terminal ON jean_ci_check_runs; DROP FUNCTION fixture_fail_terminal()'); }
  await db.reconcileReviewRestarts(startup); await assertInterrupted(source, target);
});

test('pre-ID failure and ambiguous GitHub creation terminalize without duplicate check or native submission', async () => {
  const { dispatchReviewRestart } = await import('../../lib/review-restart.ts');
  for (const failure of ['before', 'ambiguous'] as const) {
    const { source, target } = await reservedRestart();
    const before = [createCount, nextCheck, approvalPosts, reviews.length];
    githubCreateFailure = failure;
    try { await assert.rejects(dispatchReviewRestart(source), failure === 'before' ? /before creation/ : /acknowledgement lost/); }
    finally { githubCreateFailure = null; }
    await assertInterrupted(source, target);
    assert.equal((await db.getCheckRun(target))?.github_check_id, null);
    await dispatchReviewRestart(source);
    await db.reconcileReviewRestarts(new Date(Date.now() + 1000));
    assert.deepEqual([createCount, nextCheck, approvalPosts, reviews.length], [before[0], before[1] + (failure === 'ambiguous' ? 1 : 0), before[2], before[3]]);
  }
});

test('startup covers saved GitHub IDs but preserves queued and new claims and completed outcomes', async () => {
  const queued = await reservedRestart(); const old = await reservedRestart();
  const fresh = await reservedRestart(); const completed = await reservedRestart();
  await pool.query("UPDATE jean_ci_review_restarts SET dispatch_status='dispatching',dispatch_started_at=NOW(),dispatch_fenced=TRUE WHERE source_check_id=ANY($1::int[])", [[old.source, completed.source]]);
  await db.setCheckRunGithubId(old.target, 98765);
  await db.updateCheckRun(completed.target, { status: 'completed', conclusion: 'success', title: 'PASS' });
  const startup = (await pool.query("SELECT clock_timestamp()+INTERVAL '1 second' AS at")).rows[0].at;
  await db.claimReviewRestart(fresh.source);
  await pool.query('UPDATE jean_ci_review_restarts SET dispatch_started_at=$2 WHERE source_check_id=$1', [fresh.source, startup]);
  await db.reconcileReviewRestarts(startup);
  await assertInterrupted(old.source, old.target);
  assert.equal((await db.getCheckRun(queued.target))?.status, 'queued');
  assert.ok((await db.queuedReviewRestarts()).includes(queued.source));
  assert.equal((await db.getCheckRun(fresh.target))?.status, 'queued');
  assert.equal((await pool.query('SELECT dispatch_status FROM jean_ci_review_restarts WHERE source_check_id=$1', [fresh.source])).rows[0].dispatch_status, 'dispatching');
  assert.equal((await db.getCheckRun(completed.target))?.conclusion, 'success');
  assert.equal((await db.getCheckRun(completed.target))?.title, 'PASS');
  await db.finishReviewRestart(fresh.source);
});

test('two actual app processes: live old ownership survives startup and periodic recovery, death settles bounded without replay', { timeout: 15_000 }, async () => {
  const { source, target } = await reservedRestart();
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    const db = await import(${JSON.stringify(moduleUrl('db'))});
    const check = await db.claimReviewRestart(${source});
    if (!check) process.exit(2);
    console.log('owned'); setInterval(() => {}, 1000);
  `], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve()); child.once('error', reject);
      child.once('exit', code => reject(new Error(`owner exited ${code}`)));
    });
    await pool.query("UPDATE jean_ci_review_restarts SET dispatch_started_at=NOW()-INTERVAL '2 hours' WHERE source_check_id=$1", [source]);
    await db.setCheckRunGithubId(target, 777777);
    for (let i = 0; i < 3; i++) {
      await db.reconcileReviewRestarts(new Date());
      assert.equal((await db.getCheckRun(target))?.status, 'queued');
      assert.equal(await db.claimReviewRestart(source), null);
      assert.ok(!(await db.getInterruptedCheckRuns(new Date())).some(c => c.id === target), 'generic startup recovery must also respect ownership');
    }
    child.kill('SIGKILL'); await exited;
    for (let i = 0; i < 100 && (await db.getCheckRun(target))?.status !== 'completed'; i++) {
      await db.reconcileReviewRestarts(); await new Promise(r => setTimeout(r, 10));
    }
    await assertInterrupted(source, target);
  } finally { child.kill('SIGKILL'); await exited; }
});

test('rolling upgrade preserves unfenced legacy claims; absent legacy lock does not prove death', async () => {
  const { source, target } = await reservedRestart();
  await pool.query("UPDATE jean_ci_review_restarts SET dispatch_status='dispatching',dispatch_started_at=NOW()-INTERVAL '2 hours' WHERE source_check_id=$1", [source]);
  await db.setCheckRunGithubId(target, 888888);
  await db.reconcileReviewRestarts();
  assert.equal((await db.getCheckRun(target))?.status, 'queued');
  assert.equal(await db.claimReviewRestart(source), null);
  assert.ok(!(await db.getInterruptedCheckRuns(new Date())).some(c => c.id === target));
});

test('disconnected owner is fenced and safely terminalized without replay', async () => {
  const { source, target } = await reservedRestart();
  assert.equal((await db.claimReviewRestart(source))?.id, target);
  await db.assertReviewRestartOwner(source);
  const owner = (await pool.query('SELECT pid FROM pg_locks WHERE locktype=\'advisory\' AND classid=165 AND objid=$1 AND granted', [source])).rows[0];
  assert.ok(owner);
  await pool.query('SELECT pg_terminate_backend($1)', [owner.pid]);
  await assert.rejects(db.assertReviewRestartOwner(source));
  await db.reconcileReviewRestarts(); await assertInterrupted(source, target);
  await assert.rejects(db.finishReviewRestart(source));
  assert.equal((await db.getCheckRun(target))?.conclusion, 'failure');
});

test('actual restart runner fences terminal persistence when owner dies inside GitHub completion await', { timeout: 20_000 }, async () => {
  const { dispatchReviewRestart } = await import('../../lib/review-restart.ts');
  global.fetch = fixtureFetch;
  try {
    // Both a successful in-flight external write and an ambiguous error must
    // leave recovery's terminal result intact, including catch/finally cleanup.
    for (const reject of [false, true]) {
      const { source, target } = await reservedRestart();
      mode = 'once';
      const before = [createCount, nextCheck, approvalPosts];
      githubCompletion = { entered: gate(), response: gate(), reject };
      // Capture dispatch rejection immediately: its owning PG session will die.
      const running = dispatchReviewRestart(source).then(() => null, error => error);
      try {
        for (let i = 0; i < 200 && !(await db.reviewRunStore.get(target))[0]?.pending.length; i++) await new Promise(r => setTimeout(r, 10));
        assert.ok((await db.reviewRunStore.get(target))[0]?.pending.length);
        await decideReviewApproval(target, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 11, choice: 'once' }, 'operator');
        await Promise.race([githubCompletion.entered.promise, new Promise((_, fail) => setTimeout(() => fail(new Error('runner never reached GitHub completion')), 5000))]);
        assert.notEqual((await db.getCheckRun(target))?.status, 'completed');
        const owner = (await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=165 AND objid=$1 AND granted", [source])).rows[0];
        assert.ok(owner);
        await pool.query('SELECT pg_terminate_backend($1)', [owner.pid]);
        // This pool is distinct from the dedicated owner connection. Recovery
        // acquires the released cross-process lock before the response resumes.
        await db.reconcileReviewRestarts();
        await assertInterrupted(source, target);
        const settled = await db.getCheckRun(target);
        const publications = [updates.length, reviews.length, comments.length, githubRequests.length];
        githubCompletion.response.release();
        assert.ok(await running, 'dead owner dispatch must reject rather than report successful completion');
        assert.deepEqual(await db.getCheckRun(target), settled, 'no post-loss PASS or error cleanup may overwrite INCOMPLETE');
        await db.reconcileReviewRestarts();
        await dispatchReviewRestart(source);
        assert.deepEqual([updates.length, reviews.length, comments.length, githubRequests.length], publications, 'no follow-on publication after ownership loss');
        assert.deepEqual([createCount, nextCheck, approvalPosts], [before[0] + 1, before[1] + 1, before[2] + 1], 'no new run, check or approval on replay');
        await assertInterrupted(source, target);
      } finally {
        githubCompletion.response.release();
        await running;
        githubCompletion = null;
      }
    }
  } finally { global.fetch = oldFetch; }
});

test('lost reservation acknowledgement returns same receipt despite gateway outage, PR closure and changed head', async () => {
  const { source, target } = await reservedRestart();
  const { restartReview } = await import('../../lib/review-restart.ts');
  const before = [createCount, nextCheck, approvalPosts];
  global.fetch = async () => { throw new Error('gateway unavailable'); };
  try {
    for (const state of ['open', 'closed']) {
      currentState = state; currentHead = 'd'.repeat(40);
      assert.equal((await restartReview(source, 'operator')).check_id, target);
      assert.equal(await db.reserveReviewRestart(source, 'operator', async () => { throw new Error('must not validate receipt'); }), target);
    }
    assert.deepEqual([createCount, nextCheck, approvalPosts], before);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM jean_ci_review_restarts WHERE source_check_id=$1', [source])).rows[0].n, 1);
  } finally { global.fetch = oldFetch; currentState = 'open'; currentHead = 'a'.repeat(40); }
});

test('same display name global and custom checks restart independently by durable identity; legacy ambiguity fails honestly', async () => {
  const { dispatchReviewRestart } = await import('../../lib/review-restart.ts');
  const customPrompt = '# Custom collision check\n\n## Review Instructions\nInspect source for actionable defects.\n\n## Verdict Criteria\nReturn VERDICT: PASS or VERDICT: FAIL with actionable findings.';
  customFiles = [{ name: 'Code Review', path: '.jean-ci/pr-checks/Code Review.md', content: customPrompt }];
  global.fetch = async (url, init) => {
    if (String(url).includes('/runs/') && !String(url).endsWith('/approval')) return Response.json({ ...current, status: 'completed', pending_controls: [], output: 'VERDICT: PASS\nNo blocking defects.\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.' });
    return fixtureFetch(url, init);
  };
  try {
    await runPRReview(1, 'fixture', 'repo', 1, currentHead);
    const originals = (await pool.query('SELECT * FROM jean_ci_check_runs ORDER BY id DESC LIMIT 2')).rows;
    assert.deepEqual(originals.map(c => c.check_identity).sort(), ['global:code-review', 'path:.jean-ci/pr-checks/Code Review.md']);
    for (const identity of ['global:code-review', 'path:.jean-ci/pr-checks/Code Review.md']) {
      const source = originals.find(c => c.check_identity === identity).id;
      await db.updateCheckRun(source, { status: 'completed', conclusion: 'failure', title: 'Review restart interrupted', summary: 'INCOMPLETE: fixture' });
      const target = await db.reserveReviewRestart(source, 'operator', async () => {});
      const before = createCount; const reviewsBefore = reviews.length;
      await dispatchReviewRestart(source);
      const result = await db.getCheckRun(target);
      assert.equal(result?.check_identity, identity);
      assert.equal(result?.conclusion, 'success'); assert.equal(createCount, before + 1);
      assert.equal(result?.prompt, identity.startsWith('path:') ? customPrompt : await db.getConfig('user_prompt'));
      assert.equal(reviews.length - reviewsBefore, identity.startsWith('global:') ? 1 : 0, 'only built-in review publishes PR approval');
    }
    const legacy = await reservedRestart(); const before = createCount;
    await assert.rejects(dispatchReviewRestart(legacy.source), /legacy name is ambiguous/);
    await assertInterrupted(legacy.source, legacy.target); assert.equal(createCount, before);
  } finally { customFiles = []; global.fetch = oldFetch; }
});

test('baseline observation deadline survives database reload and cannot be renewed after canonical settlement', async () => {
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Code Review', head_sha: currentHead });
  let binding = await db.reviewRunStore.reserve(id, 1, hermesClient().scope, 'baseline-deadline');
  await db.reviewRunStore.bind(id, 1, 'run_baseline_deadline');
  binding = { ...binding, run_id: 'run_baseline_deadline' };
  const native = () => ({ run_id: binding.run_id!, status: 'waiting_for_approval', execution_generation: 11, pending_controls: [{ ...prompt, kind: 'approval' as const }] });
  const first = await db.reviewRunStore.observe(binding, async () => native());
  const deadline = first.pending_controls![0].app_deadline_at;
  assert.ok(deadline); assert.equal(first.pending_controls![0].deadline_approximate, true);
  assert.equal(first.pending_controls![0].expires_at, undefined);
  const reloaded = (await db.reviewRunStore.get(id))[0];
  const second = await db.reviewRunStore.observe(reloaded, async () => native());
  assert.equal(second.pending_controls![0].app_deadline_at, deadline);
  await db.reviewRunStore.observe(reloaded, async () => ({ run_id: binding.run_id!, status: 'running', pending_controls: [] }));
  const third = await db.reviewRunStore.observe((await db.reviewRunStore.get(id))[0], async () => native());
  assert.equal(third.pending_controls![0].app_deadline_at, deadline, 'old exact identity cannot mint a new pause');
  const saved = (await db.reviewRunStore.get(id))[0];
  assert.equal(saved.history![0].expiresAt, new Date(deadline! * 1000).toISOString());
  assert.equal(saved.history![0].deadlineApproximate, true);
  assert.equal(saved.denied, true, 'unconfirmed disappearance remains fail-closed');
});
