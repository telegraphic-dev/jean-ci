import { NextRequest, NextResponse } from 'next/server';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';
import { APP_BASE_URL } from '../config.ts';
import { parseBearerToken, requirePublicApiToken } from '../public-api.ts';
import {
  MCP_OAUTH_ACCESS_TOKEN_PREFIX,
  authenticateMcpOAuthToken,
  buildWwwAuthenticateHeader,
  createDbMcpOAuthStore,
} from './oauth.ts';
import { createJeanCiMcpHandler, validateMcpOrigin } from './server.ts';

let sharedHandler: McpHttpHandler | null = null;

function getMcpHandler(): McpHttpHandler {
  if (!sharedHandler) {
    sharedHandler = createJeanCiMcpHandler();
  }
  return sharedHandler;
}

function unauthorizedMcpResponse(
  resourcePath: '/mcp' | '/api/mcp',
  message = 'Unauthorized',
  error?: 'invalid_token' | 'insufficient_scope',
) {
  return NextResponse.json(
    {
      error: message,
      serverCard: '/api/mcp/server-card',
      oauthMetadata: `/.well-known/oauth-protected-resource${resourcePath}`,
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': buildWwwAuthenticateHeader(
          APP_BASE_URL,
          resourcePath,
          error,
          error ? message : undefined,
        ),
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function handleMcpHttpRequest(
  req: NextRequest,
  resourcePath: '/mcp' | '/api/mcp',
): Promise<Response> {
  const originError = validateMcpOrigin(req);
  if (originError) {
    return originError;
  }

  const bearerToken = parseBearerToken(req);
  if (!bearerToken) {
    return unauthorizedMcpResponse(resourcePath, 'Missing Bearer token');
  }

  let authInfo: AuthInfo;
  if (bearerToken.startsWith(MCP_OAUTH_ACCESS_TOKEN_PREFIX)) {
    const oauthResult = await authenticateMcpOAuthToken(
      createDbMcpOAuthStore(),
      bearerToken,
      resourcePath,
      APP_BASE_URL,
    );
    if (!oauthResult.authorized) {
      return unauthorizedMcpResponse(resourcePath, oauthResult.errorDescription, oauthResult.error);
    }
    authInfo = oauthResult.authInfo;
  } else {
    const auth = await requirePublicApiToken(req);
    if (!auth.authorized) {
      const body = await auth.response.json().catch(() => ({ error: 'Unauthorized' }));
      const message = typeof body?.error === 'string' ? body.error : 'Invalid API token';
      return unauthorizedMcpResponse(resourcePath, message, 'invalid_token');
    }

    const clientId =
      auth.source === 'db'
        ? `api-token:db:${auth.tokenId}`
        : `api-token:env:${auth.tokenFingerprint}`;
    authInfo = {
      // Never pass the raw bearer secret into tool handlers or logs.
      token: 'redacted',
      clientId,
      scopes: ['mcp', 'mcp:read', 'mcp:write'],
      extra: {
        source: auth.source,
        tokenId: auth.tokenId,
        actor: clientId,
      },
    };
  }

  return getMcpHandler().fetch(req, { authInfo });
}

export function buildMcpOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}
