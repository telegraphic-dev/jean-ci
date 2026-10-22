import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sealData } from 'iron-session';
import pg from 'pg';

// Exercises actual built Next handlers, cookie authentication and page rendering.
// No GitHub or Discord requests are allowed/needed for these guard tests.
test('built approval endpoint and page authenticate, reject CSRF/malformed bodies, and expose only canonical pending status', async () => {
  const database = process.env.REVIEW_APPROVAL_TEST_DATABASE_URL;
  if (!database || !['localhost', '127.0.0.1'].includes(new URL(database).hostname) || !new URL(database).pathname.startsWith('/jean_approval_test')) throw new Error('Explicit disposable local jean_approval_test database required');
  const secret = randomBytes(32).toString('hex');
  let uiCookie = '';
  let uiUrl = '';
  const fixture = createServer((req, res) => {
    // Optional loopback-only preview login for a disposable test cookie. Never
    // added to the application or exposed outside this test's local fixture.
    if (req.url === '/login' && uiCookie && uiUrl) { res.writeHead(302, { 'Set-Cookie': `${uiCookie}; HttpOnly; SameSite=Lax; Path=/`, Location: uiUrl }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ run_id: 'run_http_test', status: 'waiting_for_approval', execution_generation: 3, pending_controls: [{ kind: 'approval', prompt_id: 'prompt_http', execution_generation: 3, command: '<script>alert("escaped")</script> source inspection', description: 'Read required context', choices: ['once', 'deny'], timeout_s: 60 }] }));
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureAddress = fixture.address() as { port: number };
  const gateway = `http://127.0.0.1:${fixtureAddress.port}`;
  process.env.DATABASE_URL = database;
  process.env.OPENCLAW_GATEWAY_URL = gateway;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-only';
  const db = await import('../../lib/db.ts');
  const { hermesClient } = await import('../../lib/hermes-runs.ts');
  await db.initDatabase();
  const fixturePool = new pg.Pool({ connectionString: database });
  // This explicitly disposable database must not retain interrupted mocked checks
  // that startup recovery could mistake for external GitHub work.
  await fixturePool.query('TRUNCATE jean_ci_check_runs CASCADE');
  await fixturePool.end();
  const check = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Authenticated approval fixture', head_sha: 'a'.repeat(40) });
  await db.reviewRunStore.reserve(check, 1, hermesClient().scope, 'http-test');
  await db.reviewRunStore.bind(check, 1, 'run_http_test');
  const expiredId = await db.insertCheckRun({ repo: 'fixture/repo', pr_number: 1, check_name: 'Completed expired approval fixture', head_sha: 'a'.repeat(40) });
  const expiredBinding = await db.reviewRunStore.reserve(expiredId, 1, hermesClient().scope, 'expired-http-test');
  await db.reviewRunStore.bind(expiredId, 1, 'run_http_expired');
  const bound = { ...expiredBinding, run_id: 'run_http_expired' };
  await db.reviewRunStore.observe(bound, async () => ({ run_id: bound.run_id, status: 'waiting_for_approval', execution_generation: 3, pending_controls: [{ kind: 'approval', prompt_id: 'prompt_expired_http', execution_generation: 3, command: 'private expired command', description: 'private expired description', choices: ['once', 'deny'], timeout_s: 1800, expires_at: Date.now() / 1000 - 1 }] }));
  await db.reviewRunStore.observe(bound, async () => ({ run_id: bound.run_id, status: 'completed', pending_controls: [], output: 'INCOMPLETE' }));
  await db.updateCheckRun(expiredId, { status: 'completed', conclusion: 'failure' });
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const appEnv = { PATH: process.env.PATH, HOME: process.env.TMPDIR, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production' as const, DATABASE_URL: database,
    BASE_URL: origin, NEXT_PUBLIC_BASE_URL: origin, NEXT_TELEMETRY_DISABLED: '1', SESSION_SECRET: secret, ADMIN_GITHUB_ID: '42', OPENCLAW_GATEWAY_URL: gateway,
    OPENCLAW_GATEWAY_TOKEN: 'test-only', REVIEW_APPROVAL_DISCORD_WEBHOOK_URL: '' };
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    env: appEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(origin); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready, logs);
    const endpoint = `${origin}/api/checks/${check}/approval`;
    const restart = `${origin}/api/checks/${check}/restart`;
    assert.equal((await fetch(restart)).status, 405, 'GET never restarts a review');
    assert.equal((await fetch(restart, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(endpoint)).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const foreign = await sealData({ user: { id: '43', login: 'foreign' } }, { password: secret });
    assert.equal((await fetch(endpoint, { headers: { cookie: `jean-ci-session=${foreign}` } })).status, 403);
    const sealed = await sealData({ user: { id: '42', login: 'test-admin' } }, { password: secret });
    const cookie = `jean-ci-session=${sealed}`;
    assert.equal((await fetch(restart, { method: 'POST', headers: { cookie: `jean-ci-session=${foreign}`, origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const status = await fetch(endpoint, { headers: { cookie } });
    assert.equal(status.status, 200); assert.match(status.headers.get('cache-control') || '', /no-store/);
    const data = await status.json();
    assert.equal(data.requests[0].prompt_id, 'prompt_http');
    assert.equal(data.requests[0].execution_generation, 3);
    assert.ok(!JSON.stringify(data).includes('test-only'), 'gateway token never returned');
    for (const headers of [{ cookie, 'Content-Type': 'application/json' }, { cookie, origin: 'https://evil.example', 'Content-Type': 'application/json' }, { cookie, origin, 'Content-Type': 'text/plain' }]) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers: headers as Record<string, string>, body: '{}' })).status, 403);
      assert.equal((await fetch(restart, { method: 'POST', headers: headers as Record<string, string>, body: '{}' })).status, 403);
    }
    for (const body of ['{', '{}', JSON.stringify({ segment: 1, prompt_id: 'prompt_http', execution_generation: 3, choice: 'session' }), JSON.stringify({ segment: 1, prompt_id: 'prompt_http', execution_generation: 3, choice: 'once', run_id: 'foreign' })]) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body })).status, 400);
    }
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
    for (const body of ['{', '[]', '{"approve":true}', '{"head_sha":"foreign"}']) assert.equal((await fetch(restart, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body })).status, 400);
    assert.equal((await fetch(restart, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await fetch(restart, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 409, 'active check cannot be restarted');
    assert.equal((await fetch(`${origin}/api/checks/1x/approval`, { headers: { cookie } })).status, 400);
    const page = await fetch(`${origin}/checks/${check}`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Reviewer tool access/);
    assert.match(html, /Authenticated approval fixture/);
    const expiredPage = await (await fetch(`${origin}/checks/${expiredId}`, { headers: { cookie } })).text();
    assert.match(expiredPage, /Reviewer tool access/, 'completed checks retain the panel');
    assert.ok(!expiredPage.includes('private expired command'));
    const expiredData = await (await fetch(`${origin}/api/checks/${expiredId}/approval`, { headers: { cookie } })).json();
    assert.equal(expiredData.history[0].outcome, 'expired'); assert.equal(expiredData.can_restart, true); assert.equal(expiredData.requests.length, 0);
    assert.ok(!JSON.stringify(expiredData).includes('private expired'));
    const previewSeconds = Math.min(120, Math.max(0, Number(process.env.REVIEW_APPROVAL_UI_HOLD_SECONDS) || 0));
    if (previewSeconds) {
      uiCookie = cookie; uiUrl = `${origin}/checks/${expiredId}`;
      console.log(`Loopback-only test preview: ${gateway}/login`);
      await new Promise(resolve => setTimeout(resolve, previewSeconds * 1000));
    }
    const unauthPage = await fetch(`${origin}/checks/${check}`, { redirect: 'manual' });
    assert.equal(unauthPage.status, 307); assert.equal(unauthPage.headers.get('location'), `/admin?next=${encodeURIComponent(`/checks/${check}`)}`);
    await db.updateCheckRun(check, { status: 'completed', conclusion: 'neutral' });
    const terminal = await fetch(endpoint, { headers: { cookie } });
    assert.deepEqual((await terminal.json()).requests, []);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ segment: 1, prompt_id: 'prompt_http', execution_generation: 3, choice: 'once' }) })).status, 409);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', () => resolve()); });
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
  for (const config of [{ ADMIN_GITHUB_ID: '', SESSION_SECRET: secret }, { ADMIN_GITHUB_ID: '42', SESSION_SECRET: 'default-secret-change-me-in-production' }]) {
    const restricted = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
      env: { ...appEnv, ...config }, stdio: 'ignore',
    });
    try {
      const sealed = await sealData({ user: { id: '42', login: 'test-admin' } }, { password: config.SESSION_SECRET });
      let response: Response | undefined;
      for (let i = 0; i < 100; i++) {
        try { response = await fetch(`${origin}/api/checks/${check}/approval`, { headers: { cookie: `jean-ci-session=${sealed}` } }); break; } catch { await new Promise(r => setTimeout(r, 100)); }
      }
      assert.equal(response?.status, 403, 'unset admin/default session secret must fail closed even with an admin cookie');
      assert.equal((await fetch(`${origin}/api/checks/${check}/restart`, { method: 'POST', headers: { cookie: `jean-ci-session=${sealed}`, origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    } finally {
      restricted.kill('SIGTERM');
      await new Promise<void>(resolve => { if (restricted.exitCode != null) resolve(); else restricted.once('exit', () => resolve()); });
    }
  }
});
