import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverApprovalComment } from '../lib/review-approval-comments.ts';

function fixture() {
  const notices = new Map<string, any>();
  const comments: any[] = [];
  const requests: string[] = [];
  let failure = '';
  const store: any = {
    claim: async (check: number, identity: string) => {
      const key = `${check}:${identity}`;
      const row = notices.get(key) || { check_id: check, identity, marker: `nonce-${notices.size}`, lease: 'lease', uncertain: false, candidate_id: null, commentId: null };
      notices.set(key, row);
      return row.commentId ? null : { ...row };
    },
    update: async (claim: any, values: any) => {
      const row = notices.get(`${claim.check_id}:${claim.identity}`);
      if ('uncertain' in values) row.uncertain = values.uncertain;
      if (values.candidateId) row.candidate_id = String(values.candidateId);
      if (values.commentId) { row.commentId = values.commentId; row.url = values.url; }
    },
  };
  const octokit = { request: async (route: string, params: any) => {
    requests.push(route);
    assert.equal(params.owner, 'owner'); assert.equal(params.repo, 'repo');
    if (route.startsWith('POST')) {
      if (failure === 'refused') { failure = ''; throw Object.assign(new Error('forbidden'), { status: 403 }); }
      const comment = { id: comments.length + 1, body: params.body, performed_via_github_app: { id: 123 } };
      comments.push(comment);
      if (failure === 'lost') { failure = ''; throw new Error('lost create acknowledgement'); }
      return { data: comment };
    }
    if (route.endsWith('/comments')) return { data: comments };
    if (failure === 'readback') { failure = ''; throw new Error('read unavailable'); }
    return { data: comments.find(c => c.id === params.comment_id) };
  } };
  const target = { checkId: 5, identity: 'segment:run:gen:prompt', owner: 'owner', repo: 'repo', pr: 7, sha: 'a'.repeat(40), appId: 123 };
  return { target, octokit, store, notices, comments, requests, fail: (mode: string) => { failure = mode; } };
}

test('PR comment is public-safe, read back, deduplicated per request and links exact detail page', async () => {
  const f = fixture();
  for (let tick = 0; tick < 5; tick++) await deliverApprovalComment(f.target, f.octokit, f.store);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /\/checks\/5\)/);
  assert.match(f.comments[0].body, /operator decision/);
  assert.match(f.comments[0].body, new RegExp(f.target.sha));
  assert.doesNotMatch(f.comments[0].body, /python|command|token|secret/i);
  assert.equal(f.requests.filter(r => r.startsWith('POST')).length, 1);
  assert.equal(f.requests.filter(r => r.includes('/issues/comments/')).length, 1, 'verified exact created comment');
  assert.equal([...f.notices.values()][0].url, 'https://github.com/owner/repo/pull/7#issuecomment-1');
  await deliverApprovalComment({ ...f.target, identity: 'segment:run:gen:next-prompt' }, f.octokit, f.store);
  assert.equal(f.comments.length, 2, 'new native request has its own notice');
});

test('definite comment refusal retries, lost create only reconciles, readback retries same ID', async () => {
  for (const mode of ['refused', 'lost', 'readback']) {
    const f = fixture(); f.fail(mode);
    await deliverApprovalComment(f.target, f.octokit, f.store);
    assert.equal([...f.notices.values()][0].commentId, null, 'not declared delivered without readback');
    await deliverApprovalComment(f.target, f.octokit, f.store);
    assert.equal(f.comments.length, 1);
    assert.equal([...f.notices.values()][0].commentId, 1);
    assert.equal(f.requests.filter(r => r.startsWith('POST')).length, mode === 'refused' ? 2 : 1);
    if (mode === 'lost') assert.ok(f.requests.some(r => r.endsWith('/comments') && r.startsWith('GET')));
  }
});

test('ambiguous missing receipt never blindly posts again; foreign app comments are not delivery proof', async () => {
  const f = fixture(); f.fail('lost');
  await deliverApprovalComment(f.target, f.octokit, f.store);
  f.comments[0].performed_via_github_app.id = 999;
  await deliverApprovalComment(f.target, f.octokit, f.store);
  assert.equal([...f.notices.values()][0].commentId, null);
  assert.equal(f.requests.filter(r => r.startsWith('POST')).length, 1);
});
