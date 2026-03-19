import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createApiToken, listApiTokens } from '@/lib/db';
import { generateApiToken, getApiTokenPrefix, hashApiToken } from '@/lib/public-api';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const tokens = await listApiTokens();
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body?.name !== 'string') {
    return NextResponse.json({ error: 'Token name must be a string' }, { status: 400 });
  }

  const name = body.name.trim();
  if (!name) {
    return NextResponse.json({ error: 'Token name is required' }, { status: 400 });
  }

  const rawToken = generateApiToken();
  const tokenHash = hashApiToken(rawToken);
  const tokenPrefix = getApiTokenPrefix(rawToken);
  const tokenRecord = await createApiToken(name, tokenHash, tokenPrefix);

  return NextResponse.json(
    {
      token: rawToken,
      record: tokenRecord,
      warning: 'Store this token now. It will not be shown again.',
    },
    { status: 201 }
  );
}
