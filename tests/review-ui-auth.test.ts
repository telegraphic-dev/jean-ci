import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real review page, PR route and OAuth routes preserve safe return-to through sealed cookies', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--loader', './tests/support/tsx-loader.mjs', './tests/support/review-ui-scenarios.mjs'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: real routes/);
});
