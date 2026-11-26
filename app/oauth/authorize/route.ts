import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireReviewAdmin } from '@/lib/auth';
import { APP_BASE_URL } from '@/lib/config';
import {
  OAUTH_CSRF_COOKIE_NAME,
  approvePendingAuthorization,
  buildConsentHtmlHeaders,
  buildOAuthErrorRedirect,
  createDbMcpOAuthStore,
  createPendingAuthorization,
  renderConsentPageHtml,
  timingSafeEqualStrings,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isAdminOAuthConfigured(): boolean {
  const secret = process.env.SESSION_SECRET || '';
  return Boolean(
    process.env.ADMIN_GITHUB_ID &&
      secret.length >= 32 &&
      secret !== 'default-secret-change-me-in-production' &&
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET,
  );
}

function clearCsrfCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${OAUTH_CSRF_COOKIE_NAME}=; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function GET(req: NextRequest) {
  if (!isAdminOAuthConfigured()) {
    return new NextResponse(
      'MCP OAuth requires ADMIN_GITHUB_ID, SESSION_SECRET (32+ chars), GITHUB_CLIENT_ID, and GITHUB_CLIENT_SECRET to be configured.',
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const store = createDbMcpOAuthStore();
  const url = new URL(req.url);
  const result = await createPendingAuthorization(store, url.searchParams, APP_BASE_URL);
  if (!result.ok) {
    if (result.redirectErrorUrl) {
      return NextResponse.redirect(result.redirectErrorUrl, { status: 302 });
    }
    return Response.json(
      { error: result.error, error_description: result.errorDescription },
      { status: result.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const session = await getSession();
  if (!session.user) {
    const origin = new URL(APP_BASE_URL).origin;
    const nextPath = `/oauth/authorize/continue/${result.pending.requestId}`;
    return NextResponse.redirect(
      `${origin}/api/auth/github?next=${encodeURIComponent(nextPath)}`,
      { status: 302 },
    );
  }

  const admin = await requireReviewAdmin();
  if (!admin.authorized) {
    return new NextResponse(admin.error, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const html = renderConsentPageHtml(result.pending, admin.user);
  return new NextResponse(html, {
    status: 200,
    headers: buildConsentHtmlHeaders(result.pending.csrfToken),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireReviewAdmin();
  if (!admin.authorized) {
    return new NextResponse(admin.error, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return new NextResponse('Expected form-encoded authorization consent submission', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const form = new URLSearchParams(await req.text());
  const requestId = (form.get('request_id') || '').trim();
  const csrfToken = (form.get('csrf_token') || '').trim();
  const decision = (form.get('decision') || '').trim();
  const csrfCookie = req.cookies.get(OAUTH_CSRF_COOKIE_NAME)?.value || '';

  if (
    !/^[a-f0-9]{32}$/.test(requestId) ||
    !csrfToken ||
    !csrfCookie ||
    !timingSafeEqualStrings(csrfToken, csrfCookie)
  ) {
    return new NextResponse('Invalid or missing CSRF token', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const store = createDbMcpOAuthStore();
  const existing = await store.getPending(requestId);
  if (!existing) {
    return new NextResponse('Authorization request expired or not found', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (!timingSafeEqualStrings(existing.csrfToken, csrfToken)) {
    return new NextResponse('CSRF token mismatch', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const consumed = await store.consumePending(requestId);
  if (!consumed) {
    return new NextResponse('Authorization request already processed or expired', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Set-Cookie': clearCsrfCookieHeader(),
  });

  if (decision !== 'approve') {
    const denyUrl = buildOAuthErrorRedirect(
      consumed.redirectUri,
      'access_denied',
      'User denied the authorization request.',
      consumed.state,
    );
    headers.set('Location', denyUrl);
    return new NextResponse(null, { status: 302, headers });
  }

  const { redirectUrl } = await approvePendingAuthorization(store, consumed, admin.user);
  headers.set('Location', redirectUrl);
  return new NextResponse(null, { status: 302, headers });
}
