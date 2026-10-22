import { approvalPrompts, hermesClient, validControlId, terminalRun } from './hermes-runs.ts';
import type { ApprovalPrompt, RunBinding } from './hermes-runs.ts';
import { claimReviewDecision, claimReviewNotification, finishReviewDecision, getCheckRun, getRepo, reviewRunStore } from './db.ts';
import { getInstallationOctokit, getPRInfo } from './github.ts';
import { APP_BASE_URL } from './config.ts';

export class ApprovalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function validCheckId(id: string): boolean { return /^[1-9]\d{0,9}$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) <= 2147483647; }
export interface ApprovalDecision { segment: number; prompt_id: string; execution_generation: number; choice: 'once' | 'deny'; }
export function parseApprovalDecision(body: unknown): ApprovalDecision {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApprovalError(400, 'Invalid decision');
  const b = body as ApprovalDecision;
  if (Object.keys(b).sort().join(',') !== 'choice,execution_generation,prompt_id,segment' || !Number.isSafeInteger(b.segment) || b.segment < 1 || !validControlId(b.prompt_id) || !Number.isSafeInteger(b.execution_generation) || b.execution_generation < 0 || !['once', 'deny'].includes(b.choice)) throw new ApprovalError(400, 'Invalid decision');
  return b;
}
export function requireApprovalCsrf(request: Request) {
  if (request.headers.get('origin') !== new URL(APP_BASE_URL).origin || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApprovalError(403, 'Same-origin JSON request required');
}

const defaultDeps = {
  getCheck: getCheckRun, getRepo, getInstallationOctokit, getPRInfo,
  store: reviewRunStore, client: hermesClient,
  claim: claimReviewDecision, finish: finishReviewDecision,
};
export type ApprovalDeps = typeof defaultDeps;
async function activeCheck(id: number, deps: ApprovalDeps) {
  const check = await deps.getCheck(id);
  if (!check) throw new ApprovalError(404, 'Check not found');
  if (check.status === 'completed') throw new ApprovalError(409, 'Check is no longer active');
  return check;
}
export async function getReviewApprovals(id: number, deps: ApprovalDeps = defaultDeps) {
  const check = await deps.getCheck(id);
  if (!check) throw new ApprovalError(404, 'Check not found');
  if (check.status === 'completed') return { status: 'completed', check_status: check.status, requests: [] };
  const client = deps.client();
  const bindings = await deps.store.get(id);
  const requests: Array<ApprovalPrompt & { segment: number }> = [];
  const statuses: string[] = [];
  for (const binding of bindings) {
    if (!binding.run_id) { statuses.push('submitting'); continue; }
    if (binding.scope !== client.scope) throw new ApprovalError(409, 'Reviewer requester changed; existing run cannot be controlled');
    if (terminalRun(binding.status)) { statuses.push(binding.status); continue; }
    const run = await deps.store.observe(binding, () => client.status(binding.run_id!));
    statuses.push(run.status);
    for (const prompt of approvalPrompts(run)) requests.push({ ...prompt, segment: binding.segment });
  }
  return { status: requests.length ? 'waiting_for_approval' : statuses.at(-1) || check.status, check_status: check.status, approval_incomplete: bindings.some(b => b.denied), requests };
}
export async function decideReviewApproval(id: number, decision: ApprovalDecision, actor: string, deps: ApprovalDeps = defaultDeps) {
  const check = await activeCheck(id, deps);
  const binding = (await deps.store.get(id)).find(b => b.segment === decision.segment);
  const client = deps.client();
  if (!binding?.run_id || binding.scope !== client.scope) throw new ApprovalError(409, 'No controllable run for this check segment');
  const repo = await deps.getRepo(check.repo);
  if (!repo || !check.head_sha) throw new ApprovalError(409, 'Review head unavailable');
  const [owner, name] = check.repo.split('/');
  const octokit = await deps.getInstallationOctokit(repo.installation_id);
  const pr = await deps.getPRInfo(octokit, owner, name, check.pr_number);
  if (pr.head?.sha !== check.head_sha || pr.state === 'closed') throw new ApprovalError(409, 'Review head changed or PR closed');
  // Canonical request immediately before dispatch, never a cached command or
  // run ID from the browser. Hermes atomically enforces expiry and generation.
  const run = await deps.store.observe(binding, () => client.status(binding.run_id!));
  const prompt = approvalPrompts(run).find(p => p.prompt_id === decision.prompt_id && p.execution_generation === decision.execution_generation);
  if (!prompt || !prompt.choices.includes(decision.choice)) throw new ApprovalError(409, 'Approval expired, changed, or already resolved');
  await activeCheck(id, deps);
  if (!await deps.claim(binding, prompt, decision.choice, actor)) throw new ApprovalError(409, 'Decision already submitted; refresh status');
  try {
    const receipt = await client.decide(binding.run_id, prompt, decision.choice);
    if (receipt.status !== 'resolved') throw new Error('Decision not confirmed');
    const after = await deps.store.observe(binding, () => client.status(binding.run_id!));
    if (approvalPrompts(after).some(p => p.prompt_id === prompt.prompt_id && p.execution_generation === prompt.execution_generation)) throw new Error('Decision still pending');
    await deps.finish(binding, prompt, 'accepted', decision.choice);
    return { status: 'accepted', choice: decision.choice };
  } catch {
    // Ambiguous delivery is never retried automatically. Preserve the actor's
    // durable audit and make the review incomplete rather than fabricating PASS.
    await deps.finish(binding, prompt, 'uncertain', decision.choice);
    throw new ApprovalError(409, 'Decision could not be confirmed; refresh. It will not be replayed.');
  }
}

export async function notifyReviewApproval(id: number) {
  const webhook = process.env.REVIEW_APPROVAL_DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  // Only operator configuration can select the destination. No PR-supplied URL.
  try {
    const url = new URL(webhook);
    if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) return;
    const check = await getCheckRun(id);
    if (!check || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(check.repo) || !/^[a-f0-9]{40,64}$/.test(check.head_sha || '')) return;
    for (const binding of await reviewRunStore.get(id)) for (const prompt of binding.pending) {
      if (!await claimReviewNotification(id, `${binding.segment}:${prompt.execution_generation}:${prompt.prompt_id}`)) continue;
      const content = `Tool approval required: ${check.repo} @ ${check.head_sha}\n${APP_BASE_URL}/checks/${id}`;
      url.searchParams.set('wait', 'true');
      const sent = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      if (!sent.ok) throw new Error('Notification refused');
      const receipt = await sent.json();
      if (typeof receipt.id !== 'string' || !/^\d+$/.test(receipt.id)) throw new Error('Invalid notification receipt');
      const readback = new URL(url);
      readback.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${receipt.id}`;
      readback.searchParams.delete('wait');
      const verified = await fetch(readback, { signal: AbortSignal.timeout(5000) });
      if (!verified.ok) throw new Error('Notification readback unavailable');
      const message = await verified.json();
      if (message.id !== receipt.id || message.content !== content) throw new Error('Notification readback mismatch');
    }
  } catch { console.warn('Optional review approval notification unavailable'); }
}
