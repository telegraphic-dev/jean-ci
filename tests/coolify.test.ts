import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { updateDeploymentStatus } from '../lib/github.ts';

test('deployment completion can opt into strict GitHub delivery errors', async () => {
  const octokit = { request: async () => { throw new Error('synthetic GitHub outage'); } };
  await assert.rejects(updateDeploymentStatus(octokit, 'example', 'app', 1, 'success', 'Done', undefined, undefined, true), /GitHub outage/);
  // Existing unrelated callers retain their best-effort behavior.
  await updateDeploymentStatus(octokit, 'example', 'app', 1, 'success', 'Done');
});

for (const mode of ['configured', 'missing-token', 'missing-url']) {
  test(`Coolify tagged API, webhook and polling contracts (${mode})`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--loader', './tests/support/tsx-loader.mjs', './tests/support/coolify-scenarios.mjs', mode], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS: Coolify contracts/);
  });
}
