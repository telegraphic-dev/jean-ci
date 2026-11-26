import { NextRequest } from 'next/server';
import { APP_BASE_URL } from '@/lib/config';
import {
  SERVER_CARD_MEDIA_TYPE,
  buildDiscoveryJsonResponse,
  buildMcpServerCard,
} from '@/lib/mcp/server-card';

export const dynamic = 'force-dynamic';

function resolveBaseUrl(req: NextRequest): string {
  if (process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL) {
    return APP_BASE_URL;
  }
  return new URL(req.url).origin;
}

export async function GET(req: NextRequest) {
  const card = buildMcpServerCard(resolveBaseUrl(req));
  return buildDiscoveryJsonResponse(req, card, SERVER_CARD_MEDIA_TYPE);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag',
    },
  });
}
