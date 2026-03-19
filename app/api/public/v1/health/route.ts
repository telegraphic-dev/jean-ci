import { NextRequest, NextResponse } from 'next/server';
import { requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  return NextResponse.json({
    status: 'ok',
    api: 'public',
    version: 'v1',
    app: 'jean-ci',
  });
}
