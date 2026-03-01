import { NextRequest, NextResponse } from 'next/server';

// Backwards compatibility: forward /webhook/coolify to /api/webhook/coolify
export async function POST(req: NextRequest) {
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host') || 'jean-ci.telegraphic.app';
  
  const headers = new Headers(req.headers);
  const body = await req.text();
  
  const response = await fetch(`${protocol}://${host}/api/webhook/coolify`, {
    method: 'POST',
    headers,
    body,
  });
  
  const responseBody = await response.text();
  return new NextResponse(responseBody, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
  });
}
