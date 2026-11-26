import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { validateReturnTo } from '../lib/auth-return-to.ts';
import {
  InMemoryMcpOAuthStore,
  approvePendingAuthorization,
  authenticateMcpOAuthToken,
  buildAuthorizationServerMetadata,
  buildConsentHtmlHeaders,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  createPendingAuthorization,
  exchangeOAuthToken,
  fetchCimdClient,
  isCimdClientId,
  isPrivateIpAddress,
  isValidRedirectUri,
  redirectUriMatches,
  registerOAuthClient,
  renderConsentPageHtml,
  revokeOAuthToken,
  validateResourceIndicator,
} from '../lib/mcp/oauth.ts';
import { createJeanCiMcpHandler } from '../lib/mcp/server.ts';
import { InMemoryMcpTaskStore, McpTaskAbortRegistry } from '../lib/mcp/tasks.ts';

function makePkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('RFC 9728 / RFC 8414 metadata and WWW-Authenticate headers advertise /mcp and OAuth 2.1', () => {
  const baseUrl = 'https://jean-ci.example.com';
  const prmMcp = buildProtectedResourceMetadata(baseUrl, '/mcp');
  assert.equal(prmMcp.resource, 'https://jean-ci.example.com/mcp');
  assert.deepEqual(prmMcp.authorization_servers, ['https://jean-ci.example.com']);
  assert.deepEqual(prmMcp.bearer_methods_supported, ['header']);
  assert.deepEqual(prmMcp.scopes_supported, ['mcp:read', 'mcp:write']);

  const prmApiMcp = buildProtectedResourceMetadata(baseUrl, '/api/mcp');
  assert.equal(prmApiMcp.resource, 'https://jean-ci.example.com/api/mcp');

  const asMeta = buildAuthorizationServerMetadata(baseUrl);
  assert.equal(asMeta.issuer, 'https://jean-ci.example.com');
  assert.equal(asMeta.authorization_endpoint, 'https://jean-ci.example.com/oauth/authorize');
  assert.equal(asMeta.token_endpoint, 'https://jean-ci.example.com/oauth/token');
  assert.equal(asMeta.registration_endpoint, 'https://jean-ci.example.com/oauth/register');
  assert.equal(asMeta.revocation_endpoint, 'https://jean-ci.example.com/oauth/revoke');
  assert.deepEqual(asMeta.code_challenge_methods_supported, ['S256']);
  assert.equal(asMeta.client_id_metadata_document_supported, true);

  const wwwAuth = buildWwwAuthenticateHeader(baseUrl, '/mcp', 'invalid_token', 'Token expired');
  assert.match(wwwAuth, /resource_metadata="https:\/\/jean-ci\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(wwwAuth, /error="invalid_token"/);
  assert.match(wwwAuth, /scope="mcp:read mcp:write"/);
});

test('validateReturnTo allows only strict 32-hex MCP OAuth continuation paths', () => {
  const validId = '0123456789abcdef0123456789abcdef';
  assert.equal(validateReturnTo(`/oauth/authorize/continue/${validId}`), `/oauth/authorize/continue/${validId}`);
  assert.equal(validateReturnTo('/oauth/authorize/continue/short'), null);
  assert.equal(validateReturnTo(`/oauth/authorize/continue/${validId}?foo=bar`), null);
  assert.equal(validateReturnTo(`/oauth/authorize/continue/${validId}/extra`), null);
  assert.equal(validateReturnTo('/oauth/authorize/continue/GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG'), null);
  assert.equal(validateReturnTo('https://evil.example/oauth/authorize/continue/' + validId), null);
});

test('DCR (RFC 7591) registers valid clients and rejects unsafe redirect URIs and metadata', async () => {
  const store = new InMemoryMcpOAuthStore();

  // Reject insecure http non-loopback redirect URI
  const badHttp = await registerOAuthClient(store, {
    client_name: 'Bad Client',
    redirect_uris: ['http://evil.example/callback'],
  });
  assert.equal(badHttp.status, 400);
  assert.equal(badHttp.body.error, 'invalid_redirect_uri');

  // Reject fragment in redirect URI
  const badFrag = await registerOAuthClient(store, {
    redirect_uris: ['https://app.example.com/cb#frag'],
  });
  assert.equal(badFrag.status, 400);

  // Register public PKCE client with loopback callback
  const pubRes = await registerOAuthClient(store, {
    client_name: 'Claude Code',
    redirect_uris: ['http://127.0.0.1:43123/callback', 'https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  });
  assert.equal(pubRes.status, 201);
  assert.match(String(pubRes.body.client_id), /^jci_client_/);
  assert.equal(pubRes.body.client_secret, undefined);

  // Register confidential client
  const confRes = await registerOAuthClient(store, {
    client_name: 'Confidential Client',
    redirect_uris: ['https://client.example.com/cb'],
    token_endpoint_auth_method: 'client_secret_basic',
  });
  assert.equal(confRes.status, 201);
  assert.match(String(confRes.body.client_secret), /^jci_secret_/);

  // Verify redirect URI matching including RFC 8252 loopback dynamic ports
  assert.equal(isValidRedirectUri('http://127.0.0.1:9999/callback'), true);
  assert.equal(isValidRedirectUri('javascript:alert(1)'), false);
  assert.equal(redirectUriMatches(['http://127.0.0.1:43123/callback'], 'http://127.0.0.1:55555/callback'), true);
  assert.equal(redirectUriMatches(['http://127.0.0.1:43123/callback'], 'http://127.0.0.1:55555/other'), false);
  assert.equal(redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai:8443/cb'), false);
});

test('CIMD resolves valid HTTPS client metadata documents and blocks SSRF targets', async () => {
  assert.equal(isCimdClientId('https://client.example.com/oauth/client.json'), true);
  assert.equal(isCimdClientId('https://client.example.com/'), false);
  assert.equal(isCimdClientId('http://client.example.com/client.json'), false);
  assert.equal(isCimdClientId('https://127.0.0.1/client.json'), false);
  assert.equal(isCimdClientId('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isCimdClientId('https://localhost/client.json'), false);

  const clientId = 'https://app.example.com/oauth/client.json';
  // DNS pointing to private IP must be blocked (SSRF protection)
  const ssrfBlocked = await fetchCimdClient(
    clientId,
    async () => {
      throw new Error('fetch should never be called for private IP');
    },
    async () => [{ address: '10.0.0.5' }],
  );
  assert.equal(ssrfBlocked, null);

  // Valid public DNS + matching metadata JSON succeeds
  const cimdClient = await fetchCimdClient(
    clientId,
    async () =>
      new Response(
        JSON.stringify({
          client_id: clientId,
          client_name: 'CIMD MCP Host',
          redirect_uris: ['https://app.example.com/oauth/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: 'none',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    async () => [{ address: '93.184.216.34' }],
  );
  assert.ok(cimdClient);
  assert.equal(cimdClient.clientId, clientId);
  assert.equal(cimdClient.clientName, 'CIMD MCP Host');
  assert.equal(cimdClient.isCimd, true);

  // Mismatched client_id inside document is rejected
  const mismatch = await fetchCimdClient(
    clientId,
    async () =>
      new Response(
        JSON.stringify({
          client_id: 'https://other.example.com/client.json',
          redirect_uris: ['https://app.example.com/oauth/callback'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    async () => [{ address: '93.184.216.34' }],
  );
  assert.equal(mismatch, null);
});

test('full OAuth 2.1 PKCE S256 flow enforces audience, code replay revocation, refresh rotation, and revocation', async () => {
  const baseUrl = 'https://jean-ci.example.com';
  const store = new InMemoryMcpOAuthStore();

  const reg = await registerOAuthClient(store, {
    client_name: 'MCPJam Test Host',
    redirect_uris: ['http://127.0.0.1:41000/cb'],
    token_endpoint_auth_method: 'none',
  });
  assert.equal(reg.status, 201);
  const clientId = String(reg.body.client_id);
  const { verifier, challenge } = makePkcePair();

  // Reject missing PKCE
  const noPkce = await createPendingAuthorization(
    store,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      state: 'st-1',
    }),
    baseUrl,
  );
  assert.equal(noPkce.ok, false);
  assert.equal(noPkce.error, 'invalid_request');
  assert.ok(noPkce.redirectErrorUrl?.includes('error=invalid_request'));

  // Reject invalid RFC 8707 resource target
  const badResource = await createPendingAuthorization(
    store,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://evil.example/mcp',
    }),
    baseUrl,
  );
  assert.equal(badResource.ok, false);
  assert.equal(badResource.error, 'invalid_target');
  assert.equal(validateResourceIndicator('https://jean-ci.example.com/admin', baseUrl), null);

  // Valid authorization request
  const pendingRes = await createPendingAuthorization(
    store,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://jean-ci.example.com/mcp',
      scope: 'mcp:read mcp:write',
      state: 'xyz-state',
    }),
    baseUrl,
  );
  assert.equal(pendingRes.ok, true);

  // Consent HTML escapes values and sets anti-clickjacking headers
  const html = renderConsentPageHtml(pendingRes.pending, { id: '42', login: 'musketyr' });
  assert.match(html, /MCPJam Test Host/);
  assert.match(html, /@musketyr/);
  assert.match(html, /Hermes tool approvals/);
  const headers = buildConsentHtmlHeaders(pendingRes.pending.csrfToken);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);

  // Approve -> produces code + preserves state
  const { redirectUrl, code } = await approvePendingAuthorization(store, pendingRes.pending, {
    id: '42',
    login: 'musketyr',
  });
  const cbUrl = new URL(redirectUrl);
  assert.equal(cbUrl.searchParams.get('code'), code);
  assert.equal(cbUrl.searchParams.get('state'), 'xyz-state');

  // Wrong PKCE verifier fails without consuming code
  const wrongPkce = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      code_verifier: 'wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    null,
    baseUrl,
  );
  assert.equal(wrongPkce.status, 400);
  assert.equal(wrongPkce.body.error, 'invalid_grant');

  // Valid exchange issues access + refresh tokens
  const tokenRes = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      code_verifier: verifier,
      resource: 'https://jean-ci.example.com/mcp',
    }),
    null,
    baseUrl,
  );
  assert.equal(tokenRes.status, 200);
  const accessToken = String(tokenRes.body.access_token);
  const refreshToken = String(tokenRes.body.refresh_token);
  assert.equal(tokenRes.body.token_type, 'Bearer');

  // Audience check: valid for /mcp, rejected for /api/mcp!
  const authOk = await authenticateMcpOAuthToken(store, accessToken, '/mcp', baseUrl);
  assert.equal(authOk.authorized, true);
  if (authOk.authorized) {
    assert.equal(authOk.authInfo.extra?.actor, 'github:musketyr');
    assert.deepEqual(authOk.authInfo.scopes, ['mcp:read', 'mcp:write']);
  }
  const authWrongAud = await authenticateMcpOAuthToken(store, accessToken, '/api/mcp', baseUrl);
  assert.equal(authWrongAud.authorized, false);

  // Refresh token rotation
  const refreshed = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
    null,
    baseUrl,
  );
  assert.equal(refreshed.status, 200);
  const rotatedAccess = String(refreshed.body.access_token);
  const rotatedRefresh = String(refreshed.body.refresh_token);
  assert.notEqual(rotatedRefresh, refreshToken);

  // Replaying old refresh token revokes the entire token family (including rotatedAccess)
  const replayRefresh = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
    null,
    baseUrl,
  );
  assert.equal(replayRefresh.status, 400);
  const afterReplay = await authenticateMcpOAuthToken(store, rotatedAccess, '/mcp', baseUrl);
  assert.equal(afterReplay.authorized, false);

  // Replaying the original authorization code also rejects with invalid_grant
  const replayCode = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:41000/cb',
      code_verifier: verifier,
    }),
    null,
    baseUrl,
  );
  assert.equal(replayCode.status, 400);
  const afterCodeReplay = await authenticateMcpOAuthToken(store, accessToken, '/mcp', baseUrl);
  assert.equal(afterCodeReplay.authorized, false);

  // RFC 7009 revoke endpoint
  const revokeRes = await revokeOAuthToken(store, new URLSearchParams({ token: rotatedRefresh }), null);
  assert.equal(revokeRes.status, 200);
});

test('MCP server enforces mcp:write scope for read-only OAuth tokens', async () => {
  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    getOpenPRsFromEvents: async () => [],
  });

  const readOnlyOAuth: AuthInfo = {
    token: 'redacted',
    clientId: 'oauth:42:abc',
    scopes: ['mcp:read'],
    extra: { source: 'oauth', actor: 'github:musketyr' },
  };

  const makeReq = (toolName: string, args: Record<string, unknown>) =>
    new Request('https://jean-ci.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': toolName,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });

  // Read tool succeeds with mcp:read
  const readRes = await handler.fetch(makeReq('list_open_prs', {}), { authInfo: readOnlyOAuth });
  assert.equal(readRes.status, 200);
  const readJson = (await readRes.json()) as { result: { isError?: boolean } };
  assert.equal(readJson.result.isError, undefined);

  // Write tool rejected without mcp:write
  const writeRes = await handler.fetch(
    makeReq('retrigger_pr_review', { repo: 'telegraphic-dev/jean-ci', prNumber: 172 }),
    { authInfo: readOnlyOAuth },
  );
  assert.equal(writeRes.status, 200);
  const writeJson = (await writeRes.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(writeJson.result.isError, true);
  assert.match(writeJson.result.content[0].text, /mcp:write/i);
});

test('isPrivateIpAddress and isCimdClientId block hex IPv4-mapped IPv6 and special private IPv6 ranges', () => {
  const privateAddresses = [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.5',
    '192.168.1.10',
    '100.64.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:c0a8:101',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:0:127.0.0.1',
    '::127.0.0.1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::1',
    '2001:db8::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
  ];
  for (const addr of privateAddresses) {
    assert.equal(isPrivateIpAddress(addr), true, `expected ${addr} to be blocked as private`);
  }

  // Public IPv4/IPv6 addresses remain allowed
  assert.equal(isPrivateIpAddress('93.184.216.34'), false);
  assert.equal(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
  assert.equal(isPrivateIpAddress('::ffff:93.184.216.34'), false);
  assert.equal(isPrivateIpAddress('::ffff:5db8:d822'), false);

  // URL normalization converts [::ffff:127.0.0.1] to [::ffff:7f00:1] — must still be rejected
  assert.equal(isCimdClientId('https://[::ffff:127.0.0.1]/client.json'), false);
  assert.equal(isCimdClientId('https://[::ffff:7f00:1]/client.json'), false);
  assert.equal(isCimdClientId('https://[::ffff:169.254.169.254]/latest/meta-data'), false);
  assert.equal(isCimdClientId('https://[fd00::1]/client.json'), false);
  assert.equal(isCimdClientId('https://[2606:2800:220:1:248:1893:25c8:1946]/client.json'), true);
});

test('fetchCimdClient enforces streaming byte limit and pins DNS lookup on production HTTPS path', async () => {
  const clientId = 'https://stream-test.example.com/oauth/client.json';

  // Streaming body larger than 64 KiB without Content-Length must abort early without consuming remaining chunks
  let pulledChunks = 0;
  let canceled = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulledChunks += 1;
      if (pulledChunks <= 20) {
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });

  const oversizedResult = await fetchCimdClient(
    clientId,
    async () =>
      new Response(oversizedStream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    async () => [{ address: '93.184.216.34' }],
  );
  assert.equal(oversizedResult, null);
  assert.equal(canceled, true);
  assert.ok(pulledChunks <= 6, `expected stream to stop immediately after 64 KiB cap, pulled ${pulledChunks} chunks`);

  // Production HTTPS path (fetchFn omitted): pinned lookup callback resolves once and blocks private IPv6/IPv4
  let lookupCalls = 0;
  const pinnedBlocked = await fetchCimdClient(clientId, undefined, async () => {
    lookupCalls += 1;
    return [{ address: '::ffff:7f00:1', family: 6 }];
  });
  assert.equal(pinnedBlocked, null);
  assert.equal(lookupCalls, 1, 'expected single pinned DNS lookup without separate pre-check/fetch TOCTOU');
});

test('concurrent authorization code replay and refresh rotation atomically revoke issued tokens', async () => {
  const baseUrl = 'https://jean-ci.example.com';
  const store = new InMemoryMcpOAuthStore();

  const reg = await registerOAuthClient(store, {
    client_name: 'Concurrency Test Client',
    redirect_uris: ['http://127.0.0.1:42000/cb'],
    token_endpoint_auth_method: 'none',
  });
  const clientId = String(reg.body.client_id);

  // 1) Concurrent authorization code exchange race
  const { verifier: v1, challenge: c1 } = makePkcePair();
  const pending1 = await createPendingAuthorization(
    store,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:42000/cb',
      code_challenge: c1,
      code_challenge_method: 'S256',
      resource: `${baseUrl}/mcp`,
    }),
    baseUrl,
  );
  assert.equal(pending1.ok, true);
  const { code: code1 } = await approvePendingAuthorization(store, pending1.pending, { id: '42', login: 'musketyr' });

  const makeCodeExchange = () =>
    exchangeOAuthToken(
      store,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: code1,
        redirect_uri: 'http://127.0.0.1:42000/cb',
        code_verifier: v1,
        resource: `${baseUrl}/mcp`,
      }),
      null,
      baseUrl,
    );

  const [codeResA, codeResB] = await Promise.all([makeCodeExchange(), makeCodeExchange()]);
  const codeWinner = codeResA.status === 200 ? codeResA : codeResB;
  const codeLoser = codeResA.status === 200 ? codeResB : codeResA;
  assert.equal(codeWinner.status, 200);
  assert.equal(codeLoser.status, 400);
  assert.equal(codeLoser.body.error, 'invalid_grant');

  // Winning access token must have been revoked by the concurrent replay!
  const winnerAccessCheck = await authenticateMcpOAuthToken(
    store,
    String(codeWinner.body.access_token),
    '/mcp',
    baseUrl,
  );
  assert.equal(winnerAccessCheck.authorized, false);

  // 2) Concurrent refresh token rotation race
  const { verifier: v2, challenge: c2 } = makePkcePair();
  const pending2 = await createPendingAuthorization(
    store,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:42000/cb',
      code_challenge: c2,
      code_challenge_method: 'S256',
      resource: `${baseUrl}/mcp`,
    }),
    baseUrl,
  );
  assert.equal(pending2.ok, true);
  const { code: code2 } = await approvePendingAuthorization(store, pending2.pending, { id: '42', login: 'musketyr' });
  const initialTokenRes = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code2,
      redirect_uri: 'http://127.0.0.1:42000/cb',
      code_verifier: v2,
      resource: `${baseUrl}/mcp`,
    }),
    null,
    baseUrl,
  );
  assert.equal(initialTokenRes.status, 200);
  const initialRefresh = String(initialTokenRes.body.refresh_token);

  const makeRefresh = () =>
    exchangeOAuthToken(
      store,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: initialRefresh,
      }),
      null,
      baseUrl,
    );

  const [refResA, refResB] = await Promise.all([makeRefresh(), makeRefresh()]);
  const refWinner = refResA.status === 200 ? refResA : refResB;
  const refLoser = refResA.status === 200 ? refResB : refResA;
  assert.equal(refWinner.status, 200);
  assert.equal(refLoser.status, 400);
  assert.equal(refLoser.body.error, 'invalid_grant');

  // Winning successor access & refresh tokens must both be revoked by the concurrent replay!
  const rotatedAccessCheck = await authenticateMcpOAuthToken(
    store,
    String(refWinner.body.access_token),
    '/mcp',
    baseUrl,
  );
  assert.equal(rotatedAccessCheck.authorized, false);
  const followUpRefresh = await exchangeOAuthToken(
    store,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: String(refWinner.body.refresh_token),
    }),
    null,
    baseUrl,
  );
  assert.equal(followUpRefresh.status, 400);
});

