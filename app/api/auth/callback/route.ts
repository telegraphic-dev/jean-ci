import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth';
import { exchangeCodeForToken, getGitHubUser } from '../../../../lib/github';
import { validateReturnTo } from '../../../../lib/auth-return-to';
import { APP_BASE_URL } from '../../../../lib/config';

const ADMIN_GITHUB_ID = process.env.ADMIN_GITHUB_ID;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!state || !session.oauthState || !/^[a-f0-9]{32}$/.test(state) || state !== session.oauthState) {
    return new NextResponse('Invalid state', { status: 400 });
  }
  if (!code) return new NextResponse('No code provided', { status: 400 });
  const returnTo = session.oauthReturnTo === undefined ? '/admin' : validateReturnTo(session.oauthReturnTo);
  if (!returnTo) return new NextResponse('Invalid return destination', { status: 400 });

  try {
    // Use the configured app origin, never attacker-controlled Host/forwarded headers.
    const origin = new URL(APP_BASE_URL).origin;
    const tokenData = await exchangeCodeForToken(code, `${origin}/api/auth/callback`);
    if (!tokenData.access_token) return new NextResponse('Failed to get access token', { status: 400 });
    const user = await getGitHubUser(tokenData.access_token);
    if (ADMIN_GITHUB_ID && String(user.id) !== String(ADMIN_GITHUB_ID)) {
      return new NextResponse('Access denied - not an admin', { status: 403 });
    }
    session.user = { id: String(user.id), login: user.login, avatar: user.avatar_url };
    delete session.oauthState;
    delete session.oauthReturnTo;
    await session.save();
    // Return destination is bound to the sealed session's OAuth state, not callback input.
    return NextResponse.redirect(new URL(returnTo, origin));
  } catch (error) {
    console.error('OAuth error:', error);
    return new NextResponse('Authentication failed', { status: 500 });
  }
}
