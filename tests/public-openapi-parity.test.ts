import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPublicOpenApiSpec } from '../lib/public-openapi.ts';

const ROUTES_ROOT = path.join(process.cwd(), 'app', 'api', 'public', 'v1');

async function listRouteFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listRouteFiles(fullPath);
      }
      return entry.isFile() && entry.name === 'route.ts' ? [fullPath] : [];
    })
  );
  return files.flat();
}

function toOpenApiPath(routeFile: string): string {
  const relDir = path.relative(ROUTES_ROOT, path.dirname(routeFile));
  const normalized = relDir === '' ? '' : `/${relDir}`;
  return `/v1${normalized}`.replace(/\[([^\]]+)\]/g, '{$1}').replace(/\\/g, '/');
}

test('public OpenAPI paths stay in sync with implemented GET routes', async () => {
  const routeFiles = await listRouteFiles(ROUTES_ROOT);

  const implementedPaths: string[] = [];
  for (const routeFile of routeFiles) {
    const source = await fs.readFile(routeFile, 'utf8');
    if (source.includes('export async function GET')) {
      implementedPaths.push(toOpenApiPath(routeFile));
    }
  }

  const uniqueImplemented = [...new Set(implementedPaths)].sort();
  const spec = buildPublicOpenApiSpec();
  const documented = Object.keys(spec.paths).sort();

  assert.deepEqual(documented, uniqueImplemented);
  for (const pathName of documented) {
    assert.ok(spec.paths[pathName as keyof typeof spec.paths]?.get, `Missing GET operation for ${pathName}`);
  }
});
