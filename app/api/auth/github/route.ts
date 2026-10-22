import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth';
import { GITHUB_OAUTH } from '../../../../lib/github';
import crypto from 'crypto';
import { validateReturnTo } from '../../../../lib/auth-return-to';
import { APP_BASE_URL } from '../../../../lib/config';

export async function GET(req: NextRequest) {
  const requestedReturn = new URL(req.url).searchParams.get('next');
  const returnTo = requestedReturn === null ? '/admin' : validateReturnTo(requestedReturn);
  if (!returnTo) return new NextResponse('Invalid return destination', { status: 400 });
  const session = await getSession();
  const state = crypto.randomBytes(16).toString('hex');
  session.oauthState = state;
  session.oauthReturnTo = returnTo;
  await session.save();
  
  const origin = new URL(APP_BASE_URL).origin;
  
  const params = new URLSearchParams({
    client_id: GITHUB_OAUTH.CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    scope: 'read:user',
    state,
  });
  
  return NextResponse.redirect(`https://github.com/login/oauth/authorize?${params}`);
}
