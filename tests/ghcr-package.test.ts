import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRegistryPackagePayloadFromWorkflowRun,
  buildSyntheticGhcrVersionForHead,
  listGhcrPackageVersions,
  packageVersionMatchesHeadSha,
  parseGhcrPackageRef,
} from '../lib/ghcr-package.ts';

test('parseGhcrPackageRef strips tags and keeps nested package names', () => {
  assert.deepEqual(parseGhcrPackageRef('ghcr.io/Example/brick-directory/www:latest'), {
    owner: 'example',
    packageName: 'brick-directory/www',
    packageUrl: 'ghcr.io/example/brick-directory/www',
  });
});

test('packageVersionMatchesHeadSha matches sha short tag exactly', () => {
  const version = { metadata: { container: { tags: ['latest', 'sha-665e58d'] } } };

  assert.equal(packageVersionMatchesHeadSha(version, '665e58d5d75f07fd32fa4cceecd0d44df7f15b7c'), true);
  assert.equal(packageVersionMatchesHeadSha(version, '665e580000000000000000000000000000000000'), false);
});

test('buildRegistryPackagePayloadFromWorkflowRun synthesizes package event fields', () => {
  const payload = buildRegistryPackagePayloadFromWorkflowRun({
    workflowRun: {
      head_sha: '665e58d5d75f07fd32fa4cceecd0d44df7f15b7c',
      head_branch: 'main',
    },
    repository: {
      full_name: 'telegraphic-dev/openclaw-mentor',
      default_branch: 'main',
    },
    sender: { login: 'github-actions[bot]' },
    packageName: 'openclaw-mentor',
    packageUrl: 'ghcr.io/telegraphic-dev/openclaw-mentor',
    packageVersion: {
      id: 123,
      name: 'sha256:digest',
      html_url: 'https://github.com/orgs/telegraphic-dev/packages/container/openclaw-mentor/123',
      metadata: { container: { tags: ['sha-665e58d', 'latest'] } },
    },
  });

  assert.equal(payload.action, 'published');
  assert.equal(payload.registry_package.name, 'openclaw-mentor');
  assert.equal(payload.registry_package.package_version.package_url, 'ghcr.io/telegraphic-dev/openclaw-mentor');
  assert.equal(payload.registry_package.package_version.target_oid, '665e58d5d75f07fd32fa4cceecd0d44df7f15b7c');
  assert.equal(payload.registry_package.package_version.target_commitish, 'main');
});

test('buildSyntheticGhcrVersionForHead creates deployable package metadata without package API access', () => {
  const synthetic = buildSyntheticGhcrVersionForHead(
    { provider: 'coolify', package: 'ghcr.io/telegraphic-dev/pikarama:latest', coolify_app: 'app-uuid' },
    '8f88a32341a7e188933f0a71315f4fc66421bc76'
  );

  assert.equal(synthetic?.packageName, 'pikarama');
  assert.equal(synthetic?.packageUrl, 'ghcr.io/telegraphic-dev/pikarama');
  assert.equal(synthetic?.version.name, 'sha-8f88a32');
  assert.deepEqual(synthetic?.version.metadata.container.tags, ['sha-8f88a32']);
});

test('listGhcrPackageVersions falls back from org packages to user packages on 404', async () => {
  const calls: string[] = [];
  const octokit = {
    async request(route: string) {
      calls.push(route);
      if (route.startsWith('GET /orgs/')) {
        const error: any = new Error('Not Found');
        error.status = 404;
        throw error;
      }
      return { data: [{ id: 1 }] };
    },
  };

  const result = await listGhcrPackageVersions(octokit, 'personal-user', 'app');

  assert.deepEqual(result.data, [{ id: 1 }]);
  assert.deepEqual(calls, [
    'GET /orgs/{org}/packages/container/{package_name}/versions',
    'GET /users/{username}/packages/container/{package_name}/versions',
  ]);
});
