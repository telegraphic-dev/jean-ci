import { NextRequest } from 'next/server';
import { buildMcpOptionsResponse, handleMcpHttpRequest } from '@/lib/mcp/http-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return handleMcpHttpRequest(req, '/api/mcp');
}

export async function GET(req: NextRequest) {
  return handleMcpHttpRequest(req, '/api/mcp');
}

export async function DELETE(req: NextRequest) {
  return handleMcpHttpRequest(req, '/api/mcp');
}

export async function OPTIONS() {
  return buildMcpOptionsResponse();
}
