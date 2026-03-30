import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  listGatewayMethodPrivileges,
  listGatewayPlaygroundOperations,
  runGatewayPlaygroundProbe,
  type GatewayPlaygroundProbeRequest,
} from '@/lib/openclaw-playground';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  return NextResponse.json({ operations: listGatewayPlaygroundOperations(), methods: listGatewayMethodPrivileges() });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as GatewayPlaygroundProbeRequest | null;
  if (!body || !(body.mode in Object.fromEntries(listGatewayPlaygroundOperations().map((operation) => [operation.mode, true])))) {
    return NextResponse.json({ error: 'Invalid probe mode' }, { status: 400 });
  }

  const result = await runGatewayPlaygroundProbe(body);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
