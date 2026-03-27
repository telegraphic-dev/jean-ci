import { getCheckRun } from '@/lib/db';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Markdown } from '@/components/Markdown';
import { requireAuth } from '@/lib/auth';

export default async function CheckPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    redirect('/admin');
  }

  const { id } = await params;
  const checkRun = await getCheckRun(parseInt(id));
  
  if (!checkRun) {
    notFound();
  }

  const statusConfig: Record<string, { bg: string; label: string }> = {
    success: { bg: 'var(--green)', label: 'Success' },
    failure: { bg: 'var(--red)', label: 'Failed' },
    neutral: { bg: 'var(--text-muted)', label: 'Neutral' },
    queued: { bg: 'var(--yellow)', label: 'Queued' },
    in_progress: { bg: 'var(--purple)', label: 'In Progress' },
  };
  
  const status = statusConfig[checkRun.conclusion || ''] || statusConfig[checkRun.status] || statusConfig.neutral;

  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/admin" className="inline-block text-[var(--accent)] hover:text-[var(--accent-hover)] mb-6 transition-colors">
          ← Back
        </Link>
        
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 md:p-8 shadow-sm">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold mb-3">jean-ci / {checkRun.check_name}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="inline-block px-3 py-1 rounded-full text-white font-medium" style={{ background: status.bg }}>
                {status.label}
              </span>
              <span className="text-[var(--text-muted)]">·</span>
              <a href={`https://github.com/${checkRun.repo}/pull/${checkRun.pr_number}`} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
                {checkRun.repo}#{checkRun.pr_number}
              </a>
              <span className="text-[var(--text-muted)]">·</span>
              <span className="text-[var(--text-secondary)]">{checkRun.pr_title || 'PR'}</span>
              <span className="text-[var(--text-muted)]">·</span>
              <span className="text-[var(--text-muted)]">{new Date(checkRun.created_at).toLocaleString()}</span>
            </div>
          </div>
          
          {/* Review Result */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span>📝</span> Review Result
            </h2>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-4 text-sm">
              <Markdown content={checkRun.summary || 'No summary available'} />
            </div>
          </div>
          
          {/* Prompt Used */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span>🎯</span> Prompt Used
            </h2>
            <div className="bg-[var(--yellow)]/10 border border-[var(--yellow)]/20 rounded-xl p-4 text-sm max-h-80 overflow-y-auto">
              <Markdown content={checkRun.prompt || 'Default prompt'} />
            </div>
          </div>
          
          {checkRun.diff_preview && (
            <div>
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <span>📄</span> Diff Preview
              </h2>
              <div className="bg-[#1e293b] border border-[var(--border)] rounded-xl p-4 font-mono text-xs whitespace-pre overflow-x-auto max-h-96 text-slate-200">
                {checkRun.diff_preview}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
