import { NextRequest } from 'next/server';
import { APP_BASE_URL } from '@/lib/config';
import {
  buildOAuthCorsHeaders,
  createDbMcpOAuthStore,
  exchangeOAuthToken,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function parseOAuthFormBody(req: NextRequest): Promise<URLSearchParams | null> {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await req.text());
  }
  if (contentType.includes('application/json')) {
    try {
      const json = (await req.json()) as Record<string, unknown>;
      if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(json)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      return params;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(await req.text());
}

export async function POST(req: NextRequest) {
  const form = await parseOAuthFormBody(req);
  if (!form) {
    return Response.json(
      { error: 'invalid_request', error_description: 'Unable to parse token request body.' },
      {
        status: 400,
        headers: {
          ...buildOAuthCorsHeaders('POST, OPTIONS'),
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      },
    );
  }

  const result = await exchangeOAuthToken(
    createDbMcpOAuthStore(),
    form,
    req.headers.get('authorization'),
    APP_BASE_URL,
  );

  const headers: Record<string, string> = {
    ...buildOAuthCorsHeaders('POST, OPTIONS'),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };
  if (result.status === 401) {
    headers['WWW-Authenticate'] = 'Basic realm="jean-ci-oauth"';
  }

  return Response.json(result.body, {
    status: result.status,
    headers,
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: buildOAuthCorsHeaders('POST, OPTIONS'),
  });
}
