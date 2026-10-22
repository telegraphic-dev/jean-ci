import { createHash } from 'node:crypto';

export interface ApprovalPrompt {
  kind: 'approval'; prompt_id: string; execution_generation: number;
  command: string; description: string; choices: string[]; timeout_s?: number;
}
export interface HermesRun {
  run_id: string; status: string; execution_generation?: number;
  pending_controls?: ApprovalPrompt[]; output?: string;
}
export const validControlId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);
export const terminalRun = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted', 'expired', 'unknown'].includes(status);

// Capture once per operation: submission, status and decisions must use the same
// requester/profile. A rotated credential cannot inherit another requester's run.
export function hermesClient() {
  const base = (process.env.OPENCLAW_GATEWAY_URL || '').replace(/\/$/, '');
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  // Hermes selects a profile through /p/<profile> in the configured base URL,
  // not an invented profile header. Preserve that exact route for all calls.
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const scope = createHash('sha256').update(JSON.stringify([base, token])).digest('hex');
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${base}/v1${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Hermes API request refused (${response.status})`);
    return response.json();
  }
  return {
    scope,
    async supported() {
      const response = await fetch(`${base}/v1/capabilities`, { headers, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error('Unable to discover reviewer capabilities');
      const data = await response.json();
      const features = data.features || {};
      if (features.run_submission !== true) return false;
      if (features.run_status !== true || features.run_approval_response !== true || features.approval_events !== true) throw new Error('Hermes Runs lacks approval capabilities');
      return true;
    },
    async create(input: string, instructions: string, key: string): Promise<HermesRun> {
      const result = await request('/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ input, instructions }) });
      if (!validControlId(result.run_id)) throw new Error('Invalid Hermes run identity');
      return result;
    },
    async status(id: string): Promise<HermesRun> {
      if (!validControlId(id)) throw new Error('Invalid Hermes run identity');
      const result = await request(`/runs/${id}`);
      if (result.run_id !== id || typeof result.status !== 'string') throw new Error('Invalid Hermes run status');
      return result;
    },
    async decide(id: string, prompt: ApprovalPrompt, choice: 'once' | 'deny') {
      return request(`/runs/${id}/approval`, { method: 'POST', body: JSON.stringify({ request_id: prompt.prompt_id, execution_generation: prompt.execution_generation, choice }) });
    },
  };
}

export function approvalPrompts(run: HermesRun): ApprovalPrompt[] {
  if (run.status !== 'waiting_for_approval' || !Number.isSafeInteger(run.execution_generation)) return [];
  return (run.pending_controls || []).filter(p => p.kind === 'approval' && validControlId(p.prompt_id) && p.execution_generation === run.execution_generation && typeof p.command === 'string' && typeof p.description === 'string' && Array.isArray(p.choices));
}

export interface RunBinding { check_id: number; segment: number; run_id: string | null; request_key: string; scope: string; status: string; pending: ApprovalPrompt[]; denied: boolean; settling?: boolean; }
export interface RunStore {
  reserve(check: number, segment: number, scope: string, fingerprint: string): Promise<RunBinding>;
  bind(check: number, segment: number, run: string): Promise<void>;
  // Fetch under the durable row lock: responses fetched before locking are unordered.
  observe(binding: RunBinding, fetchRun: () => Promise<HermesRun>): Promise<HermesRun>;
  get(check: number): Promise<RunBinding[]>;
}
export async function runHermesReview(input: string, instructions: string, options: {
  checkId?: number; segment?: number; store?: RunStore; onWaiting?: () => Promise<void>;
  client?: ReturnType<typeof hermesClient>; sleep?: () => Promise<void>; deadlineMs?: number;
} = {}): Promise<string> {
  const client = options.client || hermesClient();
  const store = options.store;
  const fingerprint = createHash('sha256').update(JSON.stringify([input, instructions])).digest('hex');
  let binding = store && options.checkId ? await store.reserve(options.checkId, options.segment || 1, client.scope, fingerprint) : null;
  // Persist the idempotency identity BEFORE sending. Retry only this exact create,
  // never resubmit a review after a poll or decision failure.
  const key = binding?.request_key || `jean-local-${crypto.randomUUID()}`;
  let id = binding?.run_id;
  if (!id) {
    let last: unknown;
    for (let i = 0; i < 3 && !id; i++) {
      try { id = (await client.create(input, instructions, key)).run_id; } catch (error) { last = error; }
    }
    if (!id) throw last || new Error('Hermes submission failed');
    if (binding && store) { await store.bind(binding.check_id, binding.segment, id); binding = { ...binding, run_id: id }; }
  }
  const deadline = Date.now() + (options.deadlineMs ?? 540_000);
  let failures = 0;
  while (Date.now() < deadline) {
    let run: HermesRun;
    try {
      run = binding && store ? await store.observe(binding, () => client.status(id!)) : await client.status(id);
      failures = 0;
    } catch {
      if (++failures >= 5) throw new Error('INCOMPLETE: Hermes status unavailable; existing run identity retained.');
      await (options.sleep?.() || new Promise(r => setTimeout(r, 1000))); continue;
    }
    if (run.status === 'waiting_for_approval') {
      if (!binding) throw new Error('INCOMPLETE: Tool approval requires an authenticated PR check page; local reviews never auto-approve.');
      if (approvalPrompts(run).length) {
        try { await options.onWaiting?.(); } catch { console.warn('Optional approval wait announcement unavailable; existing run retained'); }
      }
    }
    if (terminalRun(run.status)) {
      if (binding && store) {
        const saved = (await store.get(binding.check_id)).find(r => r.segment === binding!.segment);
        if (!saved) throw new Error('INCOMPLETE: Review run binding unavailable.');
        if (saved.denied) throw new Error('INCOMPLETE: Tool approval was denied, expired, or could not be confirmed.');
        if (saved.settling) {
          // A native completion can beat the decision HTTP acknowledgement.
          // The durable dispatch lease bounds this wait, including after crashes.
          await (options.sleep?.() || new Promise(r => setTimeout(r, 1000)));
          continue;
        }
      }
      if (run.status !== 'completed' || typeof run.output !== 'string' || !run.output.trim()) throw new Error(`INCOMPLETE: Hermes run ended (${run.status}) without a complete review.`);
      return run.output;
    }
    await (options.sleep?.() || new Promise(r => setTimeout(r, 1000)));
  }
  throw new Error('INCOMPLETE: Timed out waiting for existing Hermes run; it was not resubmitted.');
}
