import assert from 'node:assert/strict';
import { boundary, auth, login, callback, prsRoute, request, renderCheck, renderPRs } from './review-ui-runtime.mjs';
import { validateReturnTo } from '../../lib/auth-return-to.ts';

const invalid = ['https://evil.test/checks/4934', '//evil.test', '/\\evil.test', '/checks/0', '/checks/-1', '/checks/01', '/checks/4934?next=//evil', '/checks/4934#x', '/checks/4934\n', '/checks/4934\r', '/checks/4934\t', '/%2f%2fevil', '/checks/%34%39%33%34', '/checks/4934%0a', '/checks/4934%252f', '/admin/../api/auth/logout', '/api/auth/github', '/admin/auth', '/admin/logout', '/admin/login', '/admin//evil', '/admin/./reviews', ' /admin'];
for (const value of invalid) assert.equal(validateReturnTo(value), null, JSON.stringify(value));
for (const value of ['/checks/4934', '/admin', '/admin/reviews/open']) assert.equal(validateReturnTo(value), value);

assert.equal((await prsRoute(request('/api/prs'))).status, 401);
const reads = boundary.dbReads;
await assert.rejects(renderCheck(), (error) => error.location === '/admin?next=%2Fchecks%2F4934');
assert.equal(boundary.dbReads, reads, 'unauthorized detail must not query DB');
for (const value of invalid) {
  const response = await login(request('/api/auth/github?next=' + encodeURIComponent(value)));
  assert.equal(response.status, 400, value);
}
assert.equal(boundary.cookies.size, 0);

// Real iron-session cookie sealing/unsealing; only the GitHub boundary is mocked.
const initiated = await login(request('/api/auth/github?next=%2Fchecks%2F4934', { host: 'evil.test', 'x-forwarded-proto': 'javascript' }));
assert.equal(initiated.status, 307);
const authorize = new URL(initiated.headers.get('location'));
const state = authorize.searchParams.get('state');
assert.match(state, /^[a-f0-9]{32}$/);
assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:3197/api/auth/callback');
assert.equal((await auth.getSession()).oauthReturnTo, '/checks/4934');
assert.equal((await auth.requireAuth()).authorized, false);
for (const bad of ['', 'tampered', '0'.repeat(32)]) {
  assert.equal((await callback(request('/api/auth/callback?code=fixture-good-code&state=' + bad))).status, 400);
}
assert.equal(boundary.exchanges.length, 0);
assert.equal((await callback(request('/api/auth/callback?state=' + state))).status, 400);
assert.equal((await callback(request('/api/auth/callback?state=' + state + '&code=bad'))).status, 400);
boundary.userId = 999;
assert.equal((await callback(request('/api/auth/callback?state=' + state + '&code=fixture-good-code'))).status, 403);
assert.equal((await auth.requireAuth()).authorized, false);
boundary.userId = 42;
const success = await callback(request('/api/auth/callback?state=' + state + '&code=fixture-good-code&next=https://evil.test', { host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' }));
assert.equal(success.headers.get('location'), 'http://localhost:3197/checks/4934');
assert.equal((await auth.requireAuth()).authorized, true);
assert.equal((await auth.getSession()).oauthState, undefined);
assert.equal((await auth.getSession()).oauthReturnTo, undefined);
assert.equal((await callback(request('/api/auth/callback?state=' + state + '&code=fixture-good-code'))).status, 400);

const html = await renderCheck();
assert.match(html, /owner send response/);
assert.equal((html.match(/<details\b/g) || []).length, 3);
assert.doesNotMatch(html, /<details[^>]*\bopen[=> ]/);
for (const label of ['Review details', 'Prompt Used', 'Diff Preview']) assert.ok(html.includes('>' + label + '</summary>'));
assert.match(html, /This stored diff preview is truncated/);
assert.match(html, /Historical reviews may only contain/);
assert.match(html, /Review profile/);
assert.match(html, /dashboard \(3\/14\)/);
assert.doesNotMatch(html.slice(0, html.indexOf('<details')), /Review profile|3\/14|VERDICT:/);
const list = renderPRs();
assert.equal((list.match(/href="\/checks\/4934"/g) || []).length, 3);
assert.match(list, /Latest review for current head/);
assert.match(list, /current head not reviewed/);
assert.match(list, /current head unknown/);
assert.match(list, /No review available/);
const response = await prsRoute(request('/api/prs?page=1&limit=2'));
assert.equal(response.status, 200);
const data = await response.json();
assert.equal(data.items.length, 2);
assert.equal(data.items[0].latestReviewId, 4934);
assert.equal(data.items[1].latestReviewIsCurrent, false);
assert.equal(data.total, 4);

boundary.cookies.clear();
const missingState = await callback(request('/api/auth/callback?code=fixture-good-code'));
assert.equal(missingState.status, 400);
await login(request('/api/auth/github'));
let session = await auth.getSession();
const defaultState = session.oauthState;
assert.equal((await callback(request('/api/auth/callback?state=' + defaultState + '&code=fixture-good-code'))).headers.get('location'), 'http://localhost:3197/admin');
await login(request('/api/auth/github?next=/checks/4934'));
session = await auth.getSession();
session.oauthReturnTo = '//evil.test';
const tamperedState = session.oauthState;
await session.save();
assert.equal((await callback(request('/api/auth/callback?state=' + tamperedState + '&code=fixture-good-code'))).status, 400);
// Corrupted cookie cannot provide an authenticated identity or pending state.
boundary.cookies.set('jean-ci-session', 'corrupted-cookie');
assert.equal((await auth.requireAuth()).authorized, false);
assert.equal((await callback(request('/api/auth/callback?state=' + tamperedState + '&code=fixture-good-code'))).status, 400);
console.log('PASS: real routes, sealed-cookie OAuth return, authorization, list navigation, historical disclosures');
