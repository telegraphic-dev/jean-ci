import { NextRequest } from 'next/server';
import {
  buildOAuthCorsHeaders,
  createDbMcpOAuthStore,
  registerOAuthClient,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'invalid_client_metadata', error_description: 'Invalid JSON request body.' },
      {
        status: 400,
        headers: { ...buildOAuthCorsHeaders('POST, OPTIONS'), 'Cache-Control': 'no-store' },
      },
    );
  }

  const result = await registerOAuthClient(createDbMcpOAuthStore(), body);
  return Response.json(result.body, {
    status: result.status,
    headers: {
      ...buildOAuthCorsHeaders('POST, OPTIONS'),
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: buildOAuthCorsHeaders('POST, OPTIONS'),
  });
}
