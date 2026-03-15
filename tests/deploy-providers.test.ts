import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingDeployment,
  KNOWN_DEPLOYMENT_PROVIDERS,
  parseDeploymentConfig,
  validateDeploymentTarget,
} from '../lib/deploy-provider-config.ts';

test('coolify provider validates required app uuid', () => {
  const errors = validateDeploymentTarget({
    provider: 'coolify',
    package: 'ghcr.io/example/app',
  });

  assert.ok(errors.some((error) => error.includes('coolify_app')));
});

test('noop provider accepts minimal config', () => {
  const errors = validateDeploymentTarget({
    provider: 'noop',
    package: 'ghcr.io/example/app',
  });

  assert.deepEqual(errors, []);
});

test('findMatchingDeployment matches package url', () => {
  const match = findMatchingDeployment(
    {
      deployments: [
        { provider: 'noop', package: 'ghcr.io/example/app' },
        { provider: 'coolify', package: 'ghcr.io/example/other', coolify_app: 'app-123' },
      ],
    },
    'ghcr.io/example/app',
    'app',
  );

  assert.equal(match?.provider, 'noop');
});

test('parseDeploymentConfig defaults provider to coolify for legacy config', () => {
  const parsed = parseDeploymentConfig(`deployments:\n  - package: ghcr.io/example/app\n    coolify_app: app-123\n    environment: production\n`);

  assert.equal(parsed.deployments[0]?.provider, 'coolify');
  assert.equal(parsed.deployments[0]?.coolify_app, 'app-123');
});

test('parseDeploymentConfig supports quoted values and inline comments', () => {
  const parsed = parseDeploymentConfig(`deployments:\n  - provider: "noop" # comment\n    package: 'ghcr.io/example/app'\n    environment: "review-only"\n`);

  assert.equal(parsed.deployments[0]?.provider, 'noop');
  assert.equal(parsed.deployments[0]?.package, 'ghcr.io/example/app');
  assert.equal(parsed.deployments[0]?.environment, 'review-only');
});

test('findMatchingDeployment does not match unrelated entry when packageName is missing', () => {
  const match = findMatchingDeployment(
    {
      deployments: [
        { provider: 'coolify', package: 'ghcr.io/example/first', coolify_app: 'app-1' },
        { provider: 'noop', package: 'ghcr.io/example/second' },
      ],
    },
    'ghcr.io/example/third',
    undefined,
  );

  assert.equal(match, null);
});

test('findMatchingDeployment uses exact package leaf for packageName fallback', () => {
  const match = findMatchingDeployment(
    {
      deployments: [
        { provider: 'coolify', package: 'ghcr.io/example/myapp', coolify_app: 'app-1' },
        { provider: 'noop', package: 'ghcr.io/example/app' },
      ],
    },
    'pkg.example.invalid/no-direct-match',
    'app',
  );

  assert.equal(match?.provider, 'noop');
});

test('findMatchingDeployment does not allow substring packageName matches', () => {
  const match = findMatchingDeployment(
    {
      deployments: [
        { provider: 'coolify', package: 'ghcr.io/example/myapp', coolify_app: 'app-1' },
      ],
    },
    'pkg.example.invalid/no-direct-match',
    'app',
  );

  assert.equal(match, null);
});

test('known provider list includes coolify and noop', () => {
  assert.ok(KNOWN_DEPLOYMENT_PROVIDERS.includes('coolify'));
  assert.ok(KNOWN_DEPLOYMENT_PROVIDERS.includes('noop'));
});
