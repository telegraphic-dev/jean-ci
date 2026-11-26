// Opt-in, read-only private evidence qualification. Never commit fixture bytes.
// REVIEW_RESOURCE_FIXTURE_DIR contains incident.diff, catalog.json (raw exact-head
// contents API response), and check.json (repo/head_sha/prompt/pr_title/pr_body).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildReviewContexts, splitReviewDiffBySubsystem } from '../../lib/review-context.ts';
import { decodeReviewResourceData } from '../../lib/review-resource-data.ts';
import { REVIEW_REQUEST_LIMIT, reviewRequestLength } from '../../lib/review-request.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
test('private exact-head incident has complete decoded and original review input within transport budgets', () => {
  const dir = process.env.REVIEW_RESOURCE_FIXTURE_DIR;
  assert.ok(dir, 'explicit private fixture directory required; no synthetic fallback');
  const diff = fs.readFileSync(path.join(dir, 'incident.diff'), 'utf8');
  const catalogRaw = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
  const checkRaw = fs.readFileSync(path.join(dir, 'check.json'), 'utf8');
  const check = JSON.parse(checkRaw);
  assert.equal(check.head_sha, 'b8f6e6823953435276cb8912a9a5ae2dbd7ca29c');
  assert.equal(check.repo, 'telegraphic-dev/a2a-exposed');
  assert.equal(typeof check.prompt, 'string');
  assert.ok(check.prompt.length);
  const resources = decodeReviewResourceData(diff);
  const expected = Object.entries(JSON.parse(catalogRaw).resources as Record<string, string>);
  assert.ok(expected.length > 0);
  assert.equal(resources.length, expected.length);
  for (const [uri, encoded] of expected) {
    const matches = resources.filter(r => r.uri === uri && r.side === 'added');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, 'worker/src/mcp-portable-skills-catalog.json');
    assert.equal(matches[0].text, Buffer.from(encoded, 'base64').toString('utf8'));
  }
  const limits = [200000, Number.MAX_SAFE_INTEGER];
  const receipts = [];
  for (const diffLimit of limits) {
    const contexts = buildReviewContexts({ diff, diffLimit, userPrompt: check.prompt,
      title: check.pr_title, body: check.pr_body, owner: 'telegraphic-dev', repo: 'a2a-exposed',
      source: { kind: 'github-pr', headSha: check.head_sha } });
    const originals = contexts.filter(c => !c.label.startsWith('resource data'));
    // Subsystem grouping can reorder files: compare the exact per-subsystem bytes.
    const extract = (context: string) => context.slice(context.indexOf('```diff\n') + 8, context.lastIndexOf('\n```'));
    const actual = originals.map(c => extract(c.context));
    const grouped = splitReviewDiffBySubsystem(diff, Number.MAX_SAFE_INTEGER);
    for (const group of grouped) {
      const pieces = originals.flatMap((c, i) => c.label.startsWith(`${group.subsystem} (`) ? [actual[i]] : []);
      if (originals.length === 1) assert.equal(actual[0], diff);
      else assert.equal(pieces.join(''), group.diff);
    }
    const projected = contexts.filter(c => c.label.startsWith('resource data'));
    for (const resource of resources) {
      const marker = JSON.stringify({ path: resource.path, uri: resource.uri, side: resource.side });
      const pieces = projected.filter(c => c.context.includes(marker)).map(c => {
        const start = c.context.indexOf('BEGIN RESOURCE TEXT\n') + 'BEGIN RESOURCE TEXT\n'.length;
        return c.context.slice(start, c.context.lastIndexOf('\nEND RESOURCE TEXT'));
      });
      assert.equal(pieces.join(''), resource.text);
    }
    for (const c of contexts) {
      assert.ok(c.context.includes(`Server-verified reviewed head SHA: ${check.head_sha}`));
      assert.ok(reviewRequestLength(check.prompt, c.context) <= REVIEW_REQUEST_LIMIT);
    }
    receipts.push({ diffLimit, contexts: contexts.length, originalSegments: originals.length,
      decodedSegments: projected.length, maxRequestChars: Math.max(...contexts.map(c => reviewRequestLength(check.prompt, c.context))) });
  }
  console.log(JSON.stringify({ fixtureSha256: { diff: digest(diff), catalog: digest(catalogRaw), check: digest(checkRaw) },
    reviewedHead: check.head_sha, resources: expected.length,
    decodedBytes: resources.reduce((n, r) => n + Buffer.byteLength(r.text), 0), requestLimit: REVIEW_REQUEST_LIMIT, receipts }));
});
