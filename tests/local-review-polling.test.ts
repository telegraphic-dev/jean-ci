import test from 'node:test';
import assert from 'node:assert/strict';

test('public OpenAPI spec exposes async local-review polling endpoints', async () => {
  const { buildPublicOpenApiSpec } = await import('../lib/public-openapi.ts');
  const spec = buildPublicOpenApiSpec();

  const localReviewPath = spec.paths['/v1/local-review'];
  assert.ok(localReviewPath);
  assert.ok(localReviewPath.post);
  assert.equal(localReviewPath.post.responses['202'].description, 'Accepted for async processing');
  assert.ok(localReviewPath.get);

  const pollingPath = spec.paths['/v1/local-review/{runId}'];
  assert.ok(pollingPath);
  assert.ok(pollingPath.get);
});

test('local-review polling route source returns 202 and pollUrl on POST', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/api/public/v1/local-review/route.ts', import.meta.url), 'utf8');

  assert.match(source, /status:\s*202/);
  assert.match(source, /pollUrl:\s*`?\/api\/public\/v1\/local-review\/\$\{runId\}`?/);
  assert.match(source, /enqueueLocalReviewRun/);
});

test('local-review polling path route reads runId from params', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/api/public/v1/local-review/[runId]/route.ts', import.meta.url), 'utf8');

  assert.match(source, /getLocalReviewRunStatus/);
  assert.match(source, /const \{ runId \} = await context\.params/);
});
