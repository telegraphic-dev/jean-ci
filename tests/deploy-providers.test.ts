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

test('known provider list includes coolify and noop', () => {
  assert.ok(KNOWN_DEPLOYMENT_PROVIDERS.includes('coolify'));
  assert.ok(KNOWN_DEPLOYMENT_PROVIDERS.includes('noop'));
});
