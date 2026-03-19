import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { revokeApiToken } from '@/lib/db';

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id } = await context.params;
  const tokenId = Number.parseInt(id, 10);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: 'Invalid token id' }, { status: 400 });
  }

  const revoked = await revokeApiToken(tokenId);
  if (!revoked) {
    return NextResponse.json({ error: 'Token not found' }, { status: 404 });
  }

  return NextResponse.json({ token: revoked });
}
