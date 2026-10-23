import { mock } from 'node:test';
import assert from 'node:assert/strict';
process.env.COOLIFY_URL = 'https://coolify.example';
process.env.COOLIFY_DASHBOARD_URL = 'https://dashboard.example';
if (process.argv[2] === 'missing-token') delete process.env.COOLIFY_TOKEN;
else process.env.COOLIFY_TOKEN = 'synthetic-test-token';
if (process.argv[2] === 'missing-url') delete process.env.COOLIFY_URL;
const base = { app_uuid: 'app-1', coolify_deployment_uuid: 'deploy-1', owner: 'example', repo: 'app', head_sha: 'abc123', deployment_id: 11, check_run_id: 12, logs_url: 'https://dashboard.example', app_url: 'https://app.example', installation_id: 1, created_at: new Date() };
let pending, calls = [], failCheck = false, failDeployment = false;
await mock.module('../../lib/db.ts', { namedExports: {
  savePendingDeployment: async () => {}, getPendingDeployment: async () => pending,
  getPendingDeploymentByDeploymentUuid: async id => pending?.coolify_deployment_uuid === id ? pending : null,
  deletePendingDeployment: async (app, deployment) => { calls.push(['delete', app, deployment]); if (pending?.app_uuid === app && pending?.coolify_deployment_uuid === deployment) pending = null; },
  insertEvent: async () => {}, getRepoForApp: async () => 'example/app', getLastDeploymentShaForApp: async () => null, getShaForDeploymentUuid: async () => null,
  getAllPendingDeployments: async () => pending ? [pending] : [], getReposWithPRReviewEnabled: async () => [], cleanupOldEvents: async () => 0, getAllPRReviewsForRepo: async () => [], deletePRReview: async () => {},
} });
await mock.module('../../lib/github.ts', { namedExports: {
  getInstallationOctokit: async () => ({}), updateDeploymentStatus: async (...args) => {
    assert.equal(args.at(-1), true, 'completion must request strict delivery errors');
    calls.push(['deployment', ...args]); if (failDeployment) throw Error('synthetic deployment-status outage');
  },
  updateCheck: async (...args) => { calls.push(['check', ...args]); if (failCheck) throw Error('synthetic GitHub outage'); },
} });
await mock.module('../../lib/smoke-tests.ts', { namedExports: { runSmokeTests: async args => calls.push(['smoke', args]) } });
const { triggerCoolifyDeploy, getCoolifyAppDetails } = await import('../../lib/coolify.ts');
if (process.argv[2] !== 'configured') {
  globalThis.fetch = () => { throw Error('must not fetch'); };
  assert.equal((await triggerCoolifyDeploy('app-1')).success, false);
} else {
  let requests = [];
  const respond = (body, status = 200) => { globalThis.fetch = async (url, options) => { requests.push([url, options]); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); }; };
  // Both tagged controllers return this receipt. IDs are opaque (Cuid2 -> new_public_id).
  for (const id of ['cuid2oldreceipt', 'new-public-id']) {
    respond({ message: 'Deployment request queued.', deployment_uuid: id });
    assert.deepEqual(await triggerCoolifyDeploy('app-1'), { success: true, deploymentUuid: id });
    const [url, options] = requests.at(-1);
    assert.equal(url, 'https://coolify.example/api/v1/applications/app-1/start');
    assert.equal(options.method, 'POST'); // GET becomes 405 in v4.4.7; no /restart or /deploy fallback.
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
  }
  for (const body of [{ message: 'Deployment skipped.' }, {}, null, { deployment_uuid: '' }, { deployment_uuid: 123 }, 'not JSON']) {
    respond(body); assert.equal((await triggerCoolifyDeploy('app-1')).success, false);
  }
  for (const status of [401, 403, 404, 405, 429, 500]) {
    requests = []; respond({ message: 'Rejected' }, status);
    assert.equal((await triggerCoolifyDeploy('app-1')).success, false);
    assert.equal(requests.length, 1, 'never retry uncertain deployment POSTs');
  }
  globalThis.fetch = async () => { throw Error('synthetic network failure'); };
  assert.equal((await triggerCoolifyDeploy('app-1')).success, false);
  respond({ uuid: 'app-1', fqdn: 'https://app.example', name: 'app', status: 'running:healthy', environment_id: 3 });
  assert.equal((await getCoolifyAppDetails('app-1')).projectUuid, undefined);
  const { getDeploymentProvider } = await import('../../lib/deploy-providers.ts');
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/start') ? { deployment_uuid: 'deploy-1' } : { fqdn: 'https://app.example', environment_id: 3 }));
  const result = await getDeploymentProvider('coolify').trigger({ coolify_app: 'app-1', provider: 'coolify', package: 'ghcr.io/example/app' }, { owner: 'example', repo: 'app', packageUrl: 'ghcr.io/example/app' });
  assert.equal(result.logsUrl, 'https://dashboard.example', 'flat responses must not invent project/default routes');

  const { POST } = await import('../../app/api/webhook/coolify/route.ts');
  const { runSync } = await import('../../lib/sync.ts');
  const webhook = payload => POST(new Request('https://jean.example/api/webhook/coolify', { method: 'POST', body: JSON.stringify(payload) }));
  const reset = () => { pending = { ...base }; calls = []; failCheck = false; failDeployment = false; };
  for (const event of ['deployment_success', 'deployment_failed']) {
    reset();
    // Exact toWebhook shape shared by both tagged notification classes.
    await webhook({ success: event === 'deployment_success', message: 'Deployment result', event, application_name: 'app', application_uuid: 'app-1', deployment_uuid: 'deploy-1', deployment_url: 'https://dashboard.example/logs', project: 'Project', environment: 'production' });
    assert.equal(pending, null);
    assert.deepEqual(calls.map(c => c[0]), event === 'deployment_success' ? ['deployment', 'check', 'delete', 'smoke'] : ['deployment', 'check', 'delete']);
    assert.equal(calls[1].at(-1).conclusion, event === 'deployment_success' ? 'success' : 'failure');
  }
  for (const patch of [{ deployment_uuid: 'old-deploy' }, { application_uuid: 'foreign-app' }, { deployment_uuid: undefined }, { pull_request_id: 3 }]) {
    reset(); await webhook({ event: 'deployment_success', application_uuid: 'app-1', deployment_uuid: 'deploy-1', ...patch });
    assert.ok(pending); assert.equal(calls.length, 0);
  }
  for (const failure of ['check', 'deployment']) {
    reset(); failCheck = failure === 'check'; failDeployment = failure === 'deployment';
    await assert.rejects(webhook({ event: 'deployment_success', application_uuid: 'app-1', deployment_uuid: 'deploy-1' }), /outage/);
    assert.ok(pending); assert.ok(!calls.some(c => c[0] === 'delete'));
  }
  for (const [status, conclusion] of [['finished', 'success'], ['failed', 'failure'], ['cancelled-by-user', 'cancelled'], ['queued', null], ['in_progress', null], ['unknown', null]]) {
    reset(); pending.created_at = new Date(Date.now() - 3600000); // old builds must still be polled
    globalThis.fetch = async url => { assert.equal(url, 'https://coolify.example/api/v1/deployments/deploy-1'); return new Response(JSON.stringify({ deployment_uuid: 'deploy-1', status })); };
    await runSync();
    if (conclusion) { assert.equal(pending, null); assert.equal(calls[1].at(-1).conclusion, conclusion); }
    else { assert.ok(pending); assert.equal(calls.length, 0); }
  }
  reset(); failCheck = true;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'finished' }));
  assert.ok((await runSync()).errors.some(e => e.includes('GitHub outage'))); assert.ok(pending);
  for (const status of [404, 403, 500]) {
    reset(); globalThis.fetch = async () => new Response('{}', { status }); await runSync(); assert.ok(pending); assert.equal(calls.length, 0);
  }
}
console.log('PASS: Coolify contracts');
