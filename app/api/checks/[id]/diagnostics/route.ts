import { requireReviewAdmin } from '@/lib/auth';
import { getCheckRun, reviewRunStore } from '@/lib/db';
import { hermesClient } from '@/lib/hermes-runs';
import { validCheckId } from '@/lib/review-approvals';
import { reviewDiagnostics } from '@/lib/review-diagnostics';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store, private' } });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireReviewAdmin();
  if (!auth.authorized) return json({ error: auth.error }, 403);
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const after = query.get('after') || '0';
  if ([...query.keys()].some(key => key !== 'after') || query.getAll('after').length > 1 || !validCheckId(id) || !/^\d{1,9}$/.test(after)) return json({ error: 'Invalid check or page' }, 400);
  try {
    const result = await reviewDiagnostics(Number(id), Number(after), {
      getCheck: getCheckRun, getBindings: reviewRunStore.get, client: hermesClient(),
    });
    return result ? json(result) : json({ error: 'Check not found' }, 404);
  } catch { return json({ error: 'Review details unavailable.' }, 503); }
}
