import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { GITHUB_OAUTH } from '@/lib/github';
import crypto from 'crypto';

export async function GET(req: NextRequest) {
  const session = await getSession();
  const state = crypto.randomBytes(16).toString('hex');
  session.oauthState = state;
  await session.save();
  
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host');
  
  const params = new URLSearchParams({
    client_id: GITHUB_OAUTH.CLIENT_ID,
    redirect_uri: `${protocol}://${host}/api/auth/callback`,
    scope: 'read:user',
    state,
  });
  
  return NextResponse.redirect(`https://github.com/login/oauth/authorize?${params}`);
}
