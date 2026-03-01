import { NextRequest } from 'next/server';
import { POST as coolifyWebhook } from '@/app/api/webhook/coolify/route';

// Backwards compatibility: old /webhook/coolify path
export const POST = coolifyWebhook;
