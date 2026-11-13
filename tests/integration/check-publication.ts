// Real SQL and runner; only GitHub/reviewer boundaries are mocked. Never use a
// production database: require the explicitly disposable loopback test database.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
process.env.DATABASE_URL = database;
const db = await import('../../lib/db.ts');
const { recoverInterruptedChecks } = await import('../../lib/interrupted-check-recovery.ts');
let checkId = 1000, runs = 0, publications = 0, failStart = true;
mock.module('../../lib/github.ts', { namedExports: {
  getInstallationOctokit: async () => ({}), fetchPRCheckFiles: async () => [],
  getPRInfo: async () => ({ state: 'open', title: 'Fixture', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } }),
  getPRDiff: async () => 'diff', createCheck: async () => ({ id: ++checkId }),
  updateCheck: async (...args: any[]) => {
    if (args[4].status === 'in_progress' && !failStart) return;
    throw Object.assign(new Error('Not Found'), { status: 404 });
  },
  createPRReview: async () => { publications++; },
} });
mock.module('../../lib/llm.ts', { namedExports: {
  callOpenClaw: async () => { runs++; return { success: true, response: 'VERDICT: PASS\nPRIVATE_DIAGNOSTIC' }; },
} });
const { runPRReview } = await import('../../lib/pr-review.ts');

test('owned explicit restart can retain failed publication without bypassing its claim fence', async () => {
  await db.initDatabase();
  await db.upsertRepo('fixture/check-publication', 1, true);
  const source = await db.insertCheckRun({ repo: 'fixture/check-publication', pr_number: 345,
    check_name: 'Code Review', check_identity: 'global:code-review', head_sha: 'a'.repeat(40) });
  await db.updateCheckRun(source, { status: 'completed', conclusion: 'failure' });
  const target = await db.reserveReviewRestart(source, 'fixture', async () => {});
  assert.equal((await db.claimReviewRestart(source))?.id, target);
  const before = [runs, publications];
  try {
    failStart = true;
    await runPRReview(1, 'fixture', 'check-publication', 345, 'a'.repeat(40), {
      checkId: target, checkName: 'Code Review', checkIdentity: 'global:code-review',
      assertOwner: () => db.assertReviewRestartOwner(source),
      persist: (id, data) => db.updateReviewRestartCheck(source, id, data),
    });
    const saved = (await db.getCheckRun(target))!;
    assert.equal(saved.status, 'completed'); assert.equal(saved.conclusion, 'failure');
    assert.ok(saved.github_completion);
    assert.ok(!(await db.getInterruptedCheckRuns(new Date(0))).some(c => c.id === target), 'active restart claim is not reconciled');
    assert.deepEqual([runs, publications], before);
  } finally { await db.finishReviewRestart(source); }
  assert.ok((await db.getInterruptedCheckRuns(new Date(0))).some(c => c.id === target), 'settled restart pending completion is reconciled');
});

test('durable check completion retries independently of startup cutoff without replaying reviewer or approvals', async () => {
  await db.initDatabase();
  await db.initDatabase(); // additive migration is repeatable
  await db.upsertRepo('fixture/check-publication', 1, true);
  const startup = new Date(0);
  await runPRReview(1, 'fixture', 'check-publication', 342, 'a'.repeat(40));
  let candidates = await db.getInterruptedCheckRuns(startup);
  let check = candidates.find(c => Number(c.github_check_id) === checkId)!;
  assert.ok(check, 'new terminal pending row is eligible despite being newer than startup');
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'failure');
  assert.ok(check.completed_at); assert.equal(runs, 0); assert.equal(publications, 0);
  const queued = await db.insertCheckRun({ repo: check.repo, pr_number: 343, check_name: 'Fresh live queue', github_check_id: ++checkId });
  assert.ok(!(await db.getInterruptedCheckRuns(startup)).some(c => c.id === queued), 'do not reclaim live current-process queued checks');
  await db.updateCheckRun(check.id, { summary: 'PRIVATE_DIAGNOSTIC_PRESERVED' });
  assert.deepEqual((await db.getCheckRun(check.id))!.github_completion, check.github_completion, 'unrelated writes preserve outbox');
  let unavailable = true, remoteStatus = 'queued', patches = 0;
  const recover = () => recoverInterruptedChecks({
    listInterruptedChecks: async () => (await db.getInterruptedCheckRuns(startup)).filter(c => c.id === check.id),
    getRepo: db.getRepo, getInstallationOctokit: async () => ({}),
    getGitHubCheck: async () => ({ status: remoteStatus }),
    completeGitHubCheck: async (_octokit, _owner, _repo, remoteId, updates) => {
      assert.equal(Number(remoteId), Number(check.github_check_id));
      assert.deepEqual(updates, check.github_completion);
      assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_DIAGNOSTIC/);
      patches++;
      if (unavailable) throw Object.assign(new Error('Not Found'), { status: 404 });
      remoteStatus = 'completed';
    },
    markCheckCompleted: db.updateCheckRun, detailsUrl: id => `https://fixture.invalid/checks/${id}`,
  }, startup);
  assert.equal((await recover()).failed, 1);
  assert.ok((await db.getCheckRun(check.id))!.github_completion, 'failed PATCH keeps durable retry');
  unavailable = false;
  assert.equal((await recover()).recovered, 1);
  let saved = (await db.getCheckRun(check.id))!;
  assert.equal(saved.github_completion, null);
  assert.equal(saved.summary, 'PRIVATE_DIAGNOSTIC_PRESERVED');
  assert.equal((await recover()).recovered, 0); assert.equal(patches, 2);
  assert.equal(runs, 0); assert.equal(publications, 0);

  failStart = false;
  await runPRReview(1, 'fixture', 'check-publication', 344, 'a'.repeat(40));
  check = (await db.getInterruptedCheckRuns(startup)).find(c => Number(c.github_check_id) === checkId)!;
  assert.equal(check.conclusion, 'success'); assert.match(check.summary!, /PRIVATE_DIAGNOSTIC/);
  assert.equal(runs, 1); assert.equal(publications, 1);
  // A remote terminal result must not be overwritten, including a human override.
  const before = patches;
  assert.equal((await recover()).recovered, 1);
  saved = (await db.getCheckRun(check.id))!;
  assert.equal(saved.conclusion, 'success'); assert.match(saved.summary!, /PRIVATE_DIAGNOSTIC/);
  assert.equal(saved.github_completion, null); assert.equal(patches, before);
  assert.equal(runs, 1); assert.equal(publications, 1);
});
