import { APP_BASE_URL } from '@/lib/config';
import { buildAuthorizationServerMetadata, buildOAuthCorsHeaders } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return Response.json(buildAuthorizationServerMetadata(APP_BASE_URL), {
    status: 200,
    headers: {
      ...buildOAuthCorsHeaders('GET, OPTIONS'),
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: buildOAuthCorsHeaders('GET, OPTIONS'),
  });
}
