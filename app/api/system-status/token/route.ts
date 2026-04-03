import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getGatewayTokenAdminState, revokeStoredGatewayToken } from '@/lib/openclaw-token-admin';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const tokenAdmin = await getGatewayTokenAdminState();
  return NextResponse.json({ tokenAdmin });
}

export async function DELETE() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const tokenAdmin = await revokeStoredGatewayToken();
  return NextResponse.json({ ok: true, tokenAdmin });
}
