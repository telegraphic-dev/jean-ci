import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireReviewAdmin } from '@/lib/auth';
import { APP_BASE_URL } from '@/lib/config';
import {
  buildConsentHtmlHeaders,
  createDbMcpOAuthStore,
  renderConsentPageHtml,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(requestId)) {
    return new NextResponse('Invalid authorization request ID', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const store = createDbMcpOAuthStore();
  const pending = await store.getPending(requestId);
  if (!pending) {
    return new NextResponse('Authorization request expired or not found. Please restart sign-in from your MCP client.', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const session = await getSession();
  if (!session.user) {
    const origin = new URL(APP_BASE_URL).origin;
    const nextPath = `/oauth/authorize/continue/${requestId}`;
    return NextResponse.redirect(
      `${origin}/api/auth/github?next=${encodeURIComponent(nextPath)}`,
      { status: 302 },
    );
  }

  const admin = await requireReviewAdmin();
  if (!admin.authorized) {
    return new NextResponse(admin.error, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const html = renderConsentPageHtml(pending, admin.user);
  return new NextResponse(html, {
    status: 200,
    headers: buildConsentHtmlHeaders(pending.csrfToken),
  });
}
