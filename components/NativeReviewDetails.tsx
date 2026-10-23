'use client';
import { useRef, useState } from 'react';
import { Markdown } from './Markdown';
import type { ReviewPartDiagnostic } from '../lib/review-diagnostics';

export function ReviewPartContent({ part }: { part: ReviewPartDiagnostic }) {
  return <section className="mt-4 border-t border-[var(--border)] pt-3">
    <h3 className="font-semibold">Review part {part.segment}</h3>
    <p className="text-xs my-2">Native status: {part.diagnostic?.status || part.status}. {part.denied && 'Approval denied, expired, or unconfirmed; this part cannot establish a complete review.'}</p>
    {part.diagnostic?.output ? <Markdown content={part.diagnostic.output} /> : <p>Final reviewer response unavailable. No terminal output was stored or could be recovered from the bound source.</p>}
    {part.diagnostic?.error && <p>Native reviewer execution failed.</p>}
  </section>;
}
export function NativeReviewDetails({ checkId, children }: { checkId: number; children?: React.ReactNode }) {
  const [parts, setParts] = useState<ReviewPartDiagnostic[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  async function load() {
    if (busy.current || next === null) return;
    busy.current = true; setLoading(true); setError('');
    try {
      const response = await fetch(`/api/checks/${checkId}/diagnostics?after=${next}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Review details unavailable. Try again.');
      const data = await response.json();
      setParts(p => [...p, ...data.parts]); setNext(data.next); setLoaded(true);
    } catch { setError('Review details unavailable. Try again.'); }
    finally { busy.current = false; setLoading(false); }
  }
  return <details className="mb-6 rounded-xl border border-[var(--border)] p-4" onToggle={e => { if (e.currentTarget.open && !loaded) void load(); }}>
    <summary className="cursor-pointer select-none font-semibold">Review details</summary>
    <p className="my-3 text-xs text-[var(--text-muted)]">Large reviews are divided into numbered parts. Historical reviews may only contain the summary originally stored; available canonical terminal responses are fetched read-only on expansion. These are final reviewer responses, not tool transcripts. Native output does not override an incomplete approval decision.</p>
    {children}
    {parts.map(part => <ReviewPartContent key={part.segment} part={part} />)}
    {loaded && !parts.length && <p>No native review binding was stored; final reviewer responses are unavailable.</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <p>Loading review details…</p>}
    {next !== null && (loaded || error) && <button type="button" disabled={loading} onClick={() => void load()}>{error ? 'Retry' : 'Load more review parts'}</button>}
  </details>;
}
