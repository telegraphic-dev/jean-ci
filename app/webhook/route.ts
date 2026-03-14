import { NextRequest, NextResponse } from 'next/server';
import { APP_BASE_HOST, APP_BASE_PROTOCOL } from '@/lib/config';

// Backwards compatibility: forward /webhook to /api/github/webhook
export async function POST(req: NextRequest) {
  const protocol = req.headers.get('x-forwarded-proto') || APP_BASE_PROTOCOL;
  const host = req.headers.get('host') || APP_BASE_HOST;
  
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
