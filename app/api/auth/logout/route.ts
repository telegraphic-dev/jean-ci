import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = await getSession();
  session.destroy();
  
  // Use forwarded host/proto for proper redirect behind proxy
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host');
  return NextResponse.redirect(`${protocol}://${host}/`);
}
