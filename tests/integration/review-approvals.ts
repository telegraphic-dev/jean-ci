// Run only against an explicitly provisioned disposable local PostgreSQL:
// REVIEW_APPROVAL_TEST_DATABASE_URL=postgres://... npm run test:approvals:integration
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

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
let nextCheck = 100;
const moduleUrl = (name: string) => new URL(`../../lib/${name}.ts`, import.meta.url).href;
mock.module(moduleUrl('github'), { namedExports: {
  getInstallationOctokit: async () => githubFixture, fetchPRCheckFiles: async () => [],
  getPRInfo: async () => ({ title: 'CSRF context fixture', head: { sha: currentHead }, base: { sha: 'b'.repeat(40) }, state: 'open' }),
  getPRDiff: async () => 'diff --git a/auth.ts b/auth.ts\n@@ -1 +1 @@\n-old\n+new\n',
  createCheck: async () => ({ id: ++nextCheck }), updateCheck: async (...args: any[]) => { updates.push(args.at(-1)); },
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
global.fetch = async (url, init = {}) => {
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
    return Response.json({ status: 'resolved', prompt_id: prompt.prompt_id });
  }
  return Response.json(current);
};

test('actual PR runner + PostgreSQL: once resumes, deny/expiry incomplete, no autoapproval or duplicate runs', async () => {
  try {
    await db.initDatabase(); await db.initDatabase();
    await pool.query('TRUNCATE jean_ci_check_runs CASCADE');
    await db.upsertRepo('fixture/repo', 1, true);
    for (const selected of ['once', 'deny', 'expiry', 'lost-create']) {
      mode = selected; updates.length = 0; reviews.length = 0;
      const before = createCount; const postsBefore = approvalPosts;
      const commentsBefore = comments.length;
      const running = runPRReview(1, 'fixture', 'repo', 1, currentHead);
      let checkId: number | undefined;
      // Wait for the durable native prompt, not for a transient in-memory callback.
      for (let i = 0; i < 100; i++) {
        const checks = await db.getAllCheckRuns(1);
        checkId = checks[0]?.id;
        if (checkId && (await db.reviewRunStore.get(checkId))[0]?.pending.length && comments.length > commentsBefore) break;
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
        await decideReviewApproval(checkId, { segment: 1, prompt_id: prompt.prompt_id, execution_generation: 11, choice: selected === 'deny' ? 'deny' : 'once' }, 'test-admin:operator');
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
  assert.equal((await db.reviewRunStore.get(id))[0].denied, true, 'unconfirmed dispatch after crash is incomplete');
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
  await pool.end();
});

test('optional Discord notice is safe, read back, durably deduplicated, and absent without configured webhook', async () => {
  const id = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Discord fixture', head_sha: currentHead });
  const binding = await db.reviewRunStore.reserve(id, 1, hermesClient().scope, 'discord');
  await db.reviewRunStore.bind(id, 1, 'run_discord_fixture');
  await db.reviewRunStore.observe({ ...binding, run_id: 'run_discord_fixture' }, { run_id: 'run_discord_fixture', status: 'waiting_for_approval', execution_generation: 11, pending_controls: [{ ...prompt, kind: 'approval' }] });
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
