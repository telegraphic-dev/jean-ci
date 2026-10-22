import { requireReviewAdmin } from '@/lib/auth';
import { ApprovalError, readApprovalJson, requireApprovalCsrf, validCheckId } from '@/lib/review-approvals';
import { dispatchReviewRestart, restartReview } from '@/lib/review-restart';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store, private' } });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireReviewAdmin();
  if (!auth.authorized) return json({ error: auth.error }, 403);
  const { id } = await context.params;
  if (!validCheckId(id)) return json({ error: 'Invalid check ID' }, 400);
  try {
    requireApprovalCsrf(request);
    const body = await readApprovalJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApprovalError(400, 'Restart accepts only an empty JSON object');
    const result = await restartReview(Number(id), `${auth.user.id}:${auth.user.login}`);
    void dispatchReviewRestart(Number(id)).catch(() => console.warn('Queued review restart awaits dispatcher'));
    return json(result, 202);
  } catch (error) {
    return error instanceof ApprovalError ? json({ error: error.message }, error.status) : json({ error: 'Restart could not be verified. Refresh; no approval was granted.' }, 503);
  }
}
