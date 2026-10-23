// Durable diagnostic regression with real PostgreSQL observation and actual worker.
// This suite uses the same explicitly disposable database as other approval tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHermesReview, hermesClient } from '../../lib/hermes-runs.ts';
const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
process.env.DATABASE_URL = database;
const db = await import('../../lib/db.ts');

test('worker persists exact incomplete cause before fail-closed denial, without retaining native envelope', async () => {
  await db.initDatabase();
  const id = await db.insertCheckRun({ repo: 'fixture/diagnostics', pr_number: 1, check_name: 'Diagnostic worker fixture', head_sha: 'a'.repeat(40) });
  const run = `run_diagnostic_${id}`;
  const output = 'VERDICT: INCOMPLETE\nRequired dependency contracts unavailable in pinned checkout; approval was not granted. No confirmed defect.';
  let polls = 0;
  const client = { ...hermesClient(),
    create: async () => ({ run_id: run, status: 'running' }),
    status: async () => ++polls === 1 ? { run_id: run, status: 'waiting_for_approval', execution_generation: 1, pending_controls: [{ kind: 'approval' as const, prompt_id: 'approval_diagnostic', execution_generation: 1, command: 'SECRET_TOOL_ARGUMENT', description: 'PRIVATE_DESCRIPTION', choices: ['once', 'deny'] }] }
      : { run_id: run, status: 'completed', output, messages: ['SECRET_TRANSCRIPT'], error: 'SECRET_ERROR' },
  };
  await assert.rejects(runHermesReview('input', 'instructions', { checkId: id, store: db.reviewRunStore, client, sleep: async () => {} }), /INCOMPLETE: Tool approval/);
  const saved = (await db.reviewRunStore.get(id))[0];
  assert.equal(saved.denied, true); assert.equal(saved.diagnostic?.output, output);
  assert.deepEqual(Object.keys(saved.diagnostic!).sort(), ['error', 'output', 'status']);
  assert.doesNotMatch(JSON.stringify(saved.diagnostic), /SECRET_|PRIVATE_/);
  await assert.rejects(db.reviewRunStore.observe({ ...saved, scope: 'foreign' }, async () => { throw new Error('must not fetch'); }), /identity conflict/);
  await db.reviewRunStore.observe(saved, async () => ({ run_id: run, status: 'unknown' }));
  assert.equal((await db.reviewRunStore.get(id))[0].diagnostic?.output, output, 'later source loss cannot erase finalized output');
  await db.updateCheckRun(id, { status: 'completed', conclusion: 'failure', summary: 'Reviewer execution failed INCOMPLETE' });
});
