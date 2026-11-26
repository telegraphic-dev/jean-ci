import { NextRequest, NextResponse } from 'next/server';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';
import { requirePublicApiToken } from '@/lib/public-api';
import { createJeanCiMcpHandler } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let sharedHandler: McpHttpHandler | null = null;

function getMcpHandler(): McpHttpHandler {
  if (!sharedHandler) {
    sharedHandler = createJeanCiMcpHandler();
  }
  return sharedHandler;
}

function unauthorizedMcpResponse(message = 'Unauthorized') {
  return NextResponse.json(
    {
      error: message,
      serverCard: '/api/mcp/server-card',
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="jean-ci-mcp"',
        'Cache-Control': 'no-store',
      },
    },
  );
}

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    const body = await auth.response.json().catch(() => ({ error: 'Unauthorized' }));
    return unauthorizedMcpResponse(typeof body?.error === 'string' ? body.error : 'Unauthorized');
  }

  const clientId =
    auth.source === 'db'
      ? `api-token:db:${auth.tokenId}`
      : `api-token:env:${auth.tokenFingerprint}`;
  const authInfo: AuthInfo = {
    // Never pass the raw bearer secret into tool handlers or logs.
    token: 'redacted',
    clientId,
    scopes: ['mcp'],
    extra: {
      source: auth.source,
      tokenId: auth.tokenId,
      actor: clientId,
    },
  };

  return getMcpHandler().fetch(req, { authInfo });
}

export async function POST(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function GET(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function DELETE(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}
