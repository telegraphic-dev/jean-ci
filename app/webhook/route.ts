import { NextRequest, NextResponse } from 'next/server';

// Backwards compatibility: forward /webhook to /api/github/webhook
export async function POST(req: NextRequest) {
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host') || 'jean-ci.telegraphic.app';
  
  // Clone headers
  const headers = new Headers(req.headers);
  
  // Forward to the real endpoint
  const body = await req.text();
  const response = await fetch(`${protocol}://${host}/api/github/webhook`, {
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
