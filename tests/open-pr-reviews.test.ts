import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

test('open PR data selects current-head Code Review deterministically in one query', async (t) => {
  const url = process.env.READABLE_REVIEW_TEST_DATABASE_URL;
  if (!url) return t.skip('Set READABLE_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL instance');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schema = `readable_reviews_${process.pid}_${Date.now()}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE jean_ci_repos(full_name text, pr_review_enabled boolean);
      CREATE TABLE jean_ci_webhook_events(id serial, repo text, event_type text, payload jsonb, created_at timestamp);
      CREATE TABLE jean_ci_check_runs(id integer, repo text, pr_number integer, check_name text, head_sha text, status text, conclusion text, created_at timestamp);
      INSERT INTO jean_ci_repos VALUES ('owner/repo', true);
    `);
    for (const [number, head] of [[1, 'current'], [2, 'new'], [3, 'none'], [4, null]]) {
      await client.query(`INSERT INTO jean_ci_webhook_events(repo,event_type,payload,created_at) VALUES ('owner/repo','pull_request',$1,'2026-10-22')`,
        [JSON.stringify({ number, action: 'opened', pull_request: { title: `PR ${number}`, head: head ? { sha: head } : {} } })]);
    }
    await client.query(`INSERT INTO jean_ci_check_runs VALUES
      (10,'owner/repo',1,'Code Review','old','completed','failure','2026-10-23'),
      (11,'owner/repo',1,'Code Review','current','completed','success','2026-10-22'),
      (12,'owner/repo',1,'Code Review','current','completed','success','2026-10-22'),
      (99,'owner/repo',1,'security','current','completed','failure','2026-10-24'),
      (20,'owner/repo',2,'Code Review','old','completed','success','2026-10-22'),
      (21,'owner/repo',2,'security','new','queued',NULL,'2026-10-23'),
      (40,'owner/repo',4,'Code Review','unknown','completed','success','2026-10-22');`);
    const connection = new URL(url);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { getOpenPRsFromEvents } = await import('./lib/db.ts');
      const prs = await getOpenPRsFromEvents();
      assert.equal(prs.length, 4);
      const get = (n) => prs.find(pr => pr.number === n);
      assert.equal(get(1).latestReviewId, 12);
      assert.equal(get(1).latestReviewIsCurrent, true);
      assert.equal(get(2).latestReviewId, 20);
      assert.equal(get(2).latestReviewIsCurrent, false);
      assert.equal(get(2).checkStatus, 'pending');
      assert.equal(get(3).latestReviewId, null);
      assert.equal(get(4).latestReviewIsCurrent, false);
      process.exit(0);
    `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DATABASE_URL: connection.href } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
