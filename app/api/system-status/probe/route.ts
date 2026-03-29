import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { runGatewayPlaygroundProbe, type GatewayPlaygroundProbeRequest } from '@/lib/openclaw-playground';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as GatewayPlaygroundProbeRequest | null;
  if (!body || (body.mode !== 'sessions_list' && body.mode !== 'responses_create')) {
    return NextResponse.json({ error: 'Invalid probe mode' }, { status: 400 });
  }

  const result = await runGatewayPlaygroundProbe(body);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
