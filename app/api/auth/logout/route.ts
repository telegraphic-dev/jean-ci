import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL('/', req.url));
}
