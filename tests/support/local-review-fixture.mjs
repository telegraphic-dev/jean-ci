// Run after npm run build, with READABLE_REVIEW_TEST_DATABASE_URL pointing to a disposable DB.
// Real Next UI/auth/cookies; local fake IdP and GitHub token/user HTTP boundary only.
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import { historicalSummary, actualSource } from '../fixtures/readable-review.ts';
const database = process.env.READABLE_REVIEW_TEST_DATABASE_URL;
if (!database) throw new Error('Isolated PostgreSQL required');
const client = new pg.Client({ connectionString: database });
await client.connect();
const schema = `readable_browser_${process.pid}`;
await client.query(`CREATE SCHEMA ${schema}`);
await client.query(`SET search_path TO ${schema}`);
const connection = new URL(database); connection.searchParams.set('options', `-c search_path=${schema}`);
const initialized = spawnSync(process.execPath, ['--experimental-strip-types','--input-type=module','-e',
  "const { initDatabase } = await import('./lib/db.ts'); await initDatabase(); process.exit(0);"],
  { stdio:'inherit', env:{...process.env,DATABASE_URL:connection.href},timeout:30000 });
if (initialized.status !== 0) {
  await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end();
  throw new Error('Fixture database initialization failed');
}
await client.query(`INSERT INTO jean_ci_repos(full_name,installation_id,pr_review_enabled) VALUES ('telegraphic-dev/a2a-exposed-site',1,true)`);
await client.query(`INSERT INTO jean_ci_check_runs(id,repo,pr_number,check_name,head_sha,status,conclusion,title,summary,prompt,diff_preview)
 VALUES (4934,'telegraphic-dev/a2a-exposed-site',171,'Code Review',$1,'completed','failure','Changes requested',$2,'Review blocking defects.',$3)`,
 [actualSource.headSha,historicalSummary,'diff --git a/example.ts b/example.ts\n+fixture\n\n... [truncated: 1KB remaining, 1 files not shown]']);
for (const [number, sha, title] of [[171, actualSource.headSha, 'Current review · local fixture'], [172, 'newhead', 'Older review · local fixture'], [173, 'none', 'No review · local fixture']]) {
  await client.query(`INSERT INTO jean_ci_webhook_events(repo,event_type,payload) VALUES ('telegraphic-dev/a2a-exposed-site','pull_request',$1)`,
    [JSON.stringify({number,action:'opened',pull_request:{title,head:{sha},user:{login:'fixture'},updated_at:'2026-10-22T10:00:00Z'}})]);
}
await client.query(`INSERT INTO jean_ci_check_runs(id,repo,pr_number,check_name,head_sha,status,conclusion,summary) VALUES
 (4935,'telegraphic-dev/a2a-exposed-site',172,'Code Review','oldhead','completed','success','VERDICT: PASS\nNo blocking issues.');`);
const child = spawn(process.execPath, ['--import','./tests/support/local-oauth-preload.mjs','./node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3198'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: connection.href, BASE_URL: 'http://localhost:3197',
    SESSION_SECRET:'isolated-local-fixture-secret-only-not-production',ADMIN_GITHUB_ID:'42',
    GITHUB_CLIENT_ID:'fixture-only',READABLE_REVIEW_LOCAL_FIXTURE:'1' },
});
const server = createServer((req,res) => {
  const incoming = new URL(req.url,'http://localhost:3197');
  if (incoming.pathname === '/fixture-idp') {
    const state = incoming.searchParams.get('state');
    res.setHeader('Content-Type','text/html');
    res.end(`<h1>Local fixture identity provider</h1><p>No production credentials or session.</p><a href="/api/auth/callback?code=local-fixture-code&state=${encodeURIComponent(state)}">Sign in as local fixture administrator</a>`); return;
  }
  const upstream = request({host:'127.0.0.1',port:3198,path:req.url,method:req.method,headers:req.headers}, response => {
    const headers = {...response.headers};
    if (headers.location?.startsWith('https://github.com/login/oauth/authorize?')) {
      const target = new URL(headers.location);
      headers.location = '/fixture-idp?state=' + encodeURIComponent(target.searchParams.get('state'));
    }
    res.writeHead(response.statusCode,headers); response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end('Fixture server starting'); });
  req.pipe(upstream);
});
await new Promise(resolve => server.listen(3197,'127.0.0.1',resolve));
console.log('Local authenticated fixture: http://localhost:3197/checks/4934');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  child.kill('SIGTERM'); server.close();
  await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); process.exit(0);
}
process.on('SIGTERM',stop); process.on('SIGINT',stop);
