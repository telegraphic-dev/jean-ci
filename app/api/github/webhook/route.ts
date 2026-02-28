import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { insertEvent } from '@/lib/db';
import { handleEvent } from '@/lib/webhook-handlers';

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

function verifySignature(body: string, signature: string | null): boolean {
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256');
  const body = await req.text();
  
  if (!verifySignature(body, signature)) {
    console.warn('Invalid webhook signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event');
  const delivery = req.headers.get('x-github-delivery');
  const payload = JSON.parse(body);

  console.log(`[${new Date().toISOString()}] Event: ${event}, Delivery: ${delivery}`);

  await insertEvent(event!, delivery!, payload.repository?.full_name || null, payload.action || null, payload);
  
  // Handle event asynchronously
  handleEvent(event!, payload).catch(error => {
    console.error('Error handling event:', error);
  });

  return NextResponse.json({ received: true });
}
