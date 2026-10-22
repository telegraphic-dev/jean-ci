import { requireReviewAdmin } from '@/lib/auth';
import { ApprovalError, decideReviewApproval, getReviewApprovals, parseApprovalDecision, requireApprovalCsrf, validCheckId } from '@/lib/review-approvals';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store, private' } });
const failure = (error: unknown) => error instanceof ApprovalError ? json({ error: error.message }, error.status) : json({ error: 'Reviewer status unavailable; refresh without resubmitting the review.' }, 503);
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireReviewAdmin();
  if (!auth.authorized) return json({ error: auth.error }, 403);
  const { id } = await context.params;
  if (!validCheckId(id)) return json({ error: 'Invalid check ID' }, 400);
  try { return json(await getReviewApprovals(Number(id))); } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  const auth = await requireReviewAdmin();
  if (!auth.authorized) return json({ error: auth.error }, 403);
  const { id } = await context.params;
  if (!validCheckId(id)) return json({ error: 'Invalid check ID' }, 400);
  try {
    requireApprovalCsrf(request);
    const reader = request.body?.getReader();
    if (!reader) throw new ApprovalError(400, 'Decision required');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new ApprovalError(413, 'Decision too large'); }
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApprovalError(400, 'Invalid JSON'); }
    return json(await decideReviewApproval(Number(id), parseApprovalDecision(body), `${auth.user.id}:${auth.user.login}`));
  } catch (error) { return failure(error); }
}
