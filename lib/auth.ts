import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';

const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret-change-me-in-production';
const ADMIN_GITHUB_ID = process.env.ADMIN_GITHUB_ID;

export interface SessionData {
  user?: {
    id: string;
    login: string;
    avatar: string;
  };
  oauthState?: string;
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), {
    password: SESSION_SECRET,
    cookieName: 'jean-ci-session',
    cookieOptions: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60, // 24 hours
    },
  });
}

// Control operations must never inherit requireAuth's permissive unset-admin
// behavior, nor trust cookies sealed with the application's known default key.
export async function requireReviewAdmin() {
  if (!process.env.ADMIN_GITHUB_ID || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET === 'default-secret-change-me-in-production') {
    return { authorized: false as const, error: 'Review controls require configured admin authentication' };
  }
  const session = await getSession();
  if (!session.user || String(session.user.id) !== process.env.ADMIN_GITHUB_ID) return { authorized: false as const, error: 'Administrator required' };
  return { authorized: true as const, user: session.user };
}

export async function requireAuth() {
  const session = await getSession();
  
  if (!session.user) {
    return { authorized: false, error: 'Not logged in' };
  }
  
  if (ADMIN_GITHUB_ID && String(session.user.id) !== String(ADMIN_GITHUB_ID)) {
    console.log(`[Auth] Access denied: ${session.user.id} !== ${ADMIN_GITHUB_ID}`);
    return { authorized: false, error: 'Access denied - not an admin' };
  }
  
  return { authorized: true, user: session.user };
}
