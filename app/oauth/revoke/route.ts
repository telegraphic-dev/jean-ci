import { NextRequest } from 'next/server';
import {
  buildOAuthCorsHeaders,
  createDbMcpOAuthStore,
  revokeOAuthToken,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const form = new URLSearchParams(await req.text());
  const result = await revokeOAuthToken(
    createDbMcpOAuthStore(),
    form,
    req.headers.get('authorization'),
  );
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
