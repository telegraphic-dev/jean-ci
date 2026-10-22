import { mock } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server.js';
import { historicalSummary, actualSource } from '../fixtures/readable-review.ts';

process.env.ADMIN_GITHUB_ID = '42';
process.env.SESSION_SECRET = 'isolated-readable-review-test-secret-only-2026';
const root = new URL('../../', import.meta.url);
const url = (path) => new URL(path, root).href;
export const boundary = { cookies: new Map(), writes: [], userId: 42, exchanges: [], dbReads: 0, authorized: false };
const cookieStore = {
  get(name) { const value = boundary.cookies.get(name); return value ? { name, value } : undefined; },
  set(name, value, options) { boundary.cookies.set(name, value); boundary.writes.push({ name, value, options }); },
};
mock.module('next/headers.js', { namedExports: { cookies: async () => cookieStore } });
mock.module('next/navigation.js', { namedExports: {
  redirect: (location) => { throw Object.assign(new Error('redirect'), { location }); },
  notFound: () => { throw new Error('not found'); },
} });
mock.module(url('lib/config.ts'), { namedExports: { APP_BASE_URL: 'http://localhost:3197' } });
mock.module(url('lib/github.ts'), { namedExports: {
  GITHUB_OAUTH: { CLIENT_ID: 'fixture-only' },
  exchangeCodeForToken: async (code, redirect) => { boundary.exchanges.push({ code, redirect }); return code === 'fixture-good-code' ? { access_token: 'fixture-only-token' } : {}; },
  getGitHubUser: async () => ({ id: boundary.userId, login: 'local-fixture-admin', avatar_url: '' }),
} });
export const fixturePRs = [
  { repo: 'owner/repo', number: 1, title: 'Current review', headSha: '0815457', latestReviewId: 4934, latestReviewIsCurrent: true },
  { repo: 'owner/repo', number: 2, title: 'Older review', headSha: 'newhead', latestReviewId: 4934, latestReviewIsCurrent: false },
  { repo: 'owner/repo', number: 3, title: 'No review', headSha: 'newhead', latestReviewId: null, latestReviewIsCurrent: false },
  { repo: 'owner/repo', number: 4, title: 'Unknown head', headSha: '', latestReviewId: 4934, latestReviewIsCurrent: false },
];
mock.module(url('lib/db.ts'), { namedExports: {
  getOpenPRsFromEvents: async () => fixturePRs,
  getCheckRun: async (id) => { boundary.dbReads++; return id === 4934 ? {
    id, check_name: 'Code Review', repo: 'telegraphic-dev/a2a-exposed-site', pr_number: 171,
    status: 'completed', conclusion: 'failure', pr_title: 'Local fixture of stored historical output',
    created_at: '2026-10-22T10:00:00Z', head_sha: actualSource.headSha,
    summary: historicalSummary, prompt: 'Review the supplied diff for blocking code defects.',
    diff_preview: 'diff --git a/example.ts b/example.ts\n+fixture\n\n... [truncated: 1KB remaining, 1 files not shown]',
  } : null; },
} });
mock.module(url('components/ReviewApprovalPanel.tsx'), { namedExports: { ReviewApprovalPanel: () => null } });
export const auth = await import(url('lib/auth.ts'));
export const login = (await import(url('app/api/auth/github/route.ts'))).GET;
export const callback = (await import(url('app/api/auth/callback/route.ts'))).GET;
export const prsRoute = (await import(url('app/api/prs/route.ts'))).GET;
export const CheckPage = (await import(url('app/checks/[id]/page.tsx'))).default;
export const OpenPRReviewLink = (await import(url('components/OpenPRReviewLink.tsx'))).OpenPRReviewLink;
export function request(path, headers = {}) { return new NextRequest('http://localhost:3197' + path, { headers }); }
export async function renderCheck() { return renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ id: '4934' }) })); }
export function renderPRs() { return fixturePRs.map((pr) => `<article>${renderToStaticMarkup(createElement(OpenPRReviewLink, pr))}<a href="https://github.com/${pr.repo}/pull/${pr.number}">GitHub #${pr.number}</a></article>`).join(''); }
