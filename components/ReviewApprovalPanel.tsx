'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApprovalPrompt } from '@/lib/hermes-runs';

type Pending = ApprovalPrompt & { segment: number; edit?: unknown };
export function ReviewApprovalPanel({ checkId }: { checkId: number }) {
  const router = useRouter();
  const [requests, setRequests] = useState<Pending[]>([]);
  const [status, setStatus] = useState('Loading reviewer status…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const endpoint = `/api/checks/${checkId}/approval`;
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Reviewer status unavailable');
      setRequests(data.requests);
      setStatus(data.status);
      setIncomplete(Boolean(data.approval_incomplete));
      setError('');
      if (data.check_status === 'completed') { setFinished(true); router.refresh(); }
    } catch (error) {
      setRequests([]);
      setError(error instanceof Error ? error.message : 'Reviewer status unavailable');
    }
  }, [endpoint, router]);
  useEffect(() => {
    if (finished) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [refresh, finished]);
  async function decide(prompt: Pending, choice: 'once' | 'deny') {
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        segment: prompt.segment, prompt_id: prompt.prompt_id, execution_generation: prompt.execution_generation, choice,
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Decision not confirmed');
      await refresh();
    } catch (error) {
      setRequests([]);
      setError(error instanceof Error ? error.message : 'Decision not confirmed. Refresh status; do not resubmit the review.');
    } finally { setBusy(false); }
  }
  return <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4" aria-label="Reviewer tool approvals">
    <h2 className="text-lg font-semibold">Reviewer tool access</h2>
    <p className="text-sm text-[var(--text-muted)] mt-1" role="status">{status.replaceAll('_', ' ')}. Approvals apply only to this exact request, never the whole session.</p>
    {incomplete && <p className="mt-3 text-sm text-[var(--yellow)]" role="status">A request was denied, expired, or unconfirmed. This review cannot finish as a complete PASS.</p>}
    {error && <p className="mt-3 text-sm text-[var(--red)]" role="alert">{error}</p>}
    {requests.map(prompt => <article className="mt-4 border-t border-[var(--border)] pt-4" key={`${prompt.segment}:${prompt.execution_generation}:${prompt.prompt_id}`}>
      <h3 className="font-semibold">Tool approval required · segment {prompt.segment}</h3>
      <p className="text-sm my-2 whitespace-pre-wrap break-words">{prompt.description}</p>
      <pre className="p-3 rounded-lg bg-[var(--bg-card)] text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto">{prompt.command}</pre>
      {prompt.edit != null && <pre className="mt-2 text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto">{JSON.stringify(prompt.edit, null, 2)}</pre>}
      <p className="text-xs text-[var(--text-muted)] my-2 break-all">Request {prompt.prompt_id} · generation {prompt.execution_generation}. Native expiry still applies; this is not an expiry countdown.</p>
      {typeof prompt.timeout_s === 'number' && <p className="text-xs text-[var(--text-muted)] my-2">Native timeout window: {prompt.timeout_s} seconds (not time remaining).</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || !prompt.choices.includes('once')} onClick={() => void decide(prompt, 'once')} className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white disabled:opacity-50">Approve once</button>
        <button type="button" disabled title="The gateway does not attest complete tool arguments, working directory and environment." className="px-4 py-2 rounded-lg border border-[var(--border)] opacity-50">Always approve this command in this repository</button>
        <button type="button" disabled={busy || !prompt.choices.includes('deny')} onClick={() => void decide(prompt, 'deny')} className="px-4 py-2 rounded-lg border border-[var(--border)] disabled:opacity-50">Deny</button>
      </div>
      <p className="text-xs text-[var(--text-muted)] mt-2">Repository-scoped persistent approval is unavailable: this gateway exposes redacted command text, not an attested full invocation including working directory and environment. No rule is saved. Future PRs could change code executed by the same command, so preview matching is not safe.</p>
    </article>)}
    {!requests.length && <p className="text-sm mt-3">No current approval request. Denied or expired requests cannot be replayed.</p>}
  </section>;
}
