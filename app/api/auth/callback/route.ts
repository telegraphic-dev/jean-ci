import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth';
import { exchangeCodeForToken, getGitHubUser } from '../../../../lib/github';

const ADMIN_GITHUB_ID = process.env.ADMIN_GITHUB_ID;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  
  if (state !== session.oauthState) {
    return new NextResponse('Invalid state', { status: 400 });
  }
  
  if (!code) {
    return new NextResponse('No code provided', { status: 400 });
  }
  
  try {
    const protocol = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('host');
    const redirectUri = `${protocol}://${host}/api/auth/callback`;
    
    const tokenData = await exchangeCodeForToken(code, redirectUri);
    
    if (!tokenData.access_token) {
      return new NextResponse('Failed to get access token', { status: 400 });
    }
    
    const user = await getGitHubUser(tokenData.access_token);
    
    if (ADMIN_GITHUB_ID && String(user.id) !== String(ADMIN_GITHUB_ID)) {
      return new NextResponse('Access denied - not an admin', { status: 403 });
    }
    
    session.user = {
      id: String(user.id),
      login: user.login,
      avatar: user.avatar_url,
    };
    await session.save();
    
    // Use forwarded host/proto for proper redirect behind proxy
    const adminUrl = `${protocol}://${host}/admin`;
    return NextResponse.redirect(adminUrl);
  } catch (error) {
    console.error('OAuth error:', error);
    return new NextResponse('Authentication failed', { status: 500 });
  }
}
