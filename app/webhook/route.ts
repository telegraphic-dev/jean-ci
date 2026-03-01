import { NextRequest } from 'next/server';
import { POST as githubWebhook } from '@/app/api/github/webhook/route';

// Backwards compatibility: old /webhook path
export const POST = githubWebhook;
