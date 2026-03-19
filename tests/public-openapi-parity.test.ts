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

function extractImplementedPathParams(routeFile: string): Set<string> {
  const params = new Set<string>();
  const matches = routeFile.matchAll(/\[([^\]]+)\]/g);
  for (const match of matches) {
    params.add(match[1]);
  }
  return params;
}

function extractImplementedQueryParams(source: string): Set<string> {
  const params = new Set<string>();
  const matches = source.matchAll(/searchParams\.get\(['"]([^'"]+)['"]\)/g);
  for (const match of matches) {
    params.add(match[1]);
  }
  if (source.includes('parsePaginationParams(')) {
    params.add('page');
    params.add('limit');
  }
  return params;
}

function extractDocumentedParams(specPath: any): { path: Set<string>; query: Set<string> } {
  const path = new Set<string>();
  const query = new Set<string>();
  const params = specPath?.get?.parameters ?? [];
  for (const param of params) {
    if (param?.in === 'path' && typeof param.name === 'string') {
      path.add(param.name);
    }
    if (param?.in === 'query' && typeof param.name === 'string') {
      query.add(param.name);
    }
  }
  return { path, query };
}

test('public OpenAPI paths stay in sync with implemented GET routes', async () => {
  const routeFiles = await listRouteFiles(ROUTES_ROOT);

  const implementedPaths: string[] = [];
  const implementationByPath = new Map<string, { path: Set<string>; query: Set<string> }>();
  for (const routeFile of routeFiles) {
    const source = await fs.readFile(routeFile, 'utf8');
    if (source.includes('export async function GET')) {
      const pathName = toOpenApiPath(routeFile);
      implementedPaths.push(pathName);
      implementationByPath.set(pathName, {
        path: extractImplementedPathParams(routeFile),
        query: extractImplementedQueryParams(source),
      });
    }
  }

  const uniqueImplemented = [...new Set(implementedPaths)].sort();
  const spec = buildPublicOpenApiSpec();
  const documented = Object.keys(spec.paths).sort();

  assert.deepEqual(documented, uniqueImplemented);
  for (const pathName of documented) {
    const specPath = spec.paths[pathName as keyof typeof spec.paths];
    assert.ok(specPath?.get, `Missing GET operation for ${pathName}`);

    const implemented = implementationByPath.get(pathName);
    assert.ok(implemented, `Missing implementation metadata for ${pathName}`);

    const documentedParams = extractDocumentedParams(specPath);
    assert.deepEqual(
      [...documentedParams.path].sort(),
      [...implemented.path].sort(),
      `Path param mismatch for ${pathName}`
    );
    assert.deepEqual(
      [...documentedParams.query].sort(),
      [...implemented.query].sort(),
      `Query param mismatch for ${pathName}`
    );
  }
});
