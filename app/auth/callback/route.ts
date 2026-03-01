import { NextRequest, NextResponse } from 'next/server';

// Backwards compatibility: old /auth/callback path
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.pathname = '/api/auth/callback';
  return NextResponse.redirect(url.toString(), 307);
}
