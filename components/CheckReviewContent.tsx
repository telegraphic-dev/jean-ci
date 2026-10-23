import { NativeReviewDetails } from './NativeReviewDetails';
import { Markdown } from './Markdown';
import { linkReviewedLocations, readableReviewSummary } from '../lib/review-output';

/** Receives persisted check fields only; never fetches native runs/tool arguments. */
export function CheckReviewContent({ summary, prompt, diff, repo, headSha, diagnosticCheckId }: {
  diagnosticCheckId?: number;
  summary?: string | null; prompt?: string | null; diff?: string | null; repo: string; headSha: string;
}) {
  const [owner, name, extra] = repo.split('/');
  const result = readableReviewSummary(summary || 'No summary available');
  const readable = extra ? result : linkReviewedLocations(result, { owner: owner || '', repo: name || '', headSha, diff: diff || '' });
  const disclosure = 'mb-6 rounded-xl border border-[var(--border)] p-4';
  const trigger = 'cursor-pointer select-none font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
  return <>
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-4 text-sm mb-6">
      <Markdown content={readable} />
    </div>
    {diagnosticCheckId ? <NativeReviewDetails checkId={diagnosticCheckId}>
      {summary && summary !== result && <div className="text-sm"><h3 className="font-semibold">Combined review output and profiles</h3><Markdown content={summary} /></div>}
    </NativeReviewDetails> : <details className={disclosure}>
      <summary className={trigger}>Review details</summary>
      <p className="mt-3 mb-3 text-xs text-[var(--text-muted)]">Persisted review output, including available profiles and segment identity. Historical reviews may only contain the summary originally stored.</p>
      <div className="text-sm"><Markdown content={summary && summary !== result ? summary : 'No additional review details were stored.'} /></div>
    </details>}
    <details className={disclosure}>
      <summary className={trigger}>Prompt Used</summary>
      <div className="mt-3 bg-[var(--yellow)]/10 border border-[var(--yellow)]/20 rounded-xl p-4 text-sm max-h-80 overflow-y-auto">
        <Markdown content={prompt || 'Default prompt'} />
      </div>
    </details>
    {diff && <details className={disclosure}>
      <summary className={trigger}>Diff Preview</summary>
      {/\[truncated:/.test(diff) && <p className="my-3 text-sm text-[var(--text-secondary)]">This stored diff preview is truncated; it does not contain the full reviewed diff.</p>}
      <pre className="mt-3 bg-[#1e293b] border border-[var(--border)] rounded-xl p-4 font-mono text-xs whitespace-pre overflow-x-auto max-h-96 text-slate-200">{diff}</pre>
    </details>}
  </>;
}
