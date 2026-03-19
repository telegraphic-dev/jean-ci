import { NextRequest, NextResponse } from 'next/server';
import { getTaskEvents, getTaskStats, getTaskSummary } from '@/lib/db';
import { parsePaginationParams, requirePublicApiToken } from '@/lib/public-api';

export async function GET(req: NextRequest) {
  const auth = await requirePublicApiToken(req);
  if (!auth.authorized) {
    return auth.response;
  }

  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'summary';
  const repo = url.searchParams.get('repo') || undefined;
  const taskName = url.searchParams.get('task') || undefined;

  if (view === 'summary') {
    const [summary, stats] = await Promise.all([getTaskSummary(repo), getTaskStats()]);
    return NextResponse.json({ summary, stats });
  }

  const { limit, offset } = parsePaginationParams(req, { defaultLimit: 50, maxLimit: 100 });
  const [{ events, total }, stats] = await Promise.all([
    getTaskEvents({ repo, taskName, limit, offset }),
    getTaskStats(),
  ]);

  return NextResponse.json({ events, total, stats, limit, offset });
}
