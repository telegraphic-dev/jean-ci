import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getConfig, setConfig, DEFAULT_USER_PROMPT } from '@/lib/db';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const userPrompt = await getConfig('user_prompt') || DEFAULT_USER_PROMPT;
  return NextResponse.json({ user_prompt: userPrompt });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  
  const { user_prompt } = await req.json();
  
  if (user_prompt !== undefined) {
    await setConfig('user_prompt', user_prompt);
  }
  
  return NextResponse.json({ success: true });
}
