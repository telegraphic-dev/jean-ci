import { getCheckRun } from '@/lib/db';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CheckReviewContent } from '@/components/CheckReviewContent';
import { validateReturnTo } from '@/lib/auth-return-to';
import { requireAuth, requireReviewAdmin } from '@/lib/auth';
import { ReviewApprovalPanel } from '@/components/ReviewApprovalPanel';

export default async function CheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAuth();
  if (!auth.authorized) {
    const returnTo = validateReturnTo(`/checks/${id}`);
    redirect(returnTo ? `/admin?next=${encodeURIComponent(returnTo)}` : '/admin');
  }

  const reviewAdmin = await requireReviewAdmin();
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
          
          {reviewAdmin.authorized && <ReviewApprovalPanel checkId={checkRun.id} />}
          {/* Review Result */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span>📝</span> Review Result
            </h2>
            {checkRun.manually_overridden && (
              <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800">
                <div className="font-semibold">Manual override applied</div>
                <div className="mt-1">By: {checkRun.overridden_by || 'admin'}</div>
                {checkRun.overridden_at && <div>At: {new Date(checkRun.overridden_at).toLocaleString()}</div>}
                {checkRun.override_reason && <div className="mt-2">Reason: {checkRun.override_reason}</div>}
              </div>
            )}
            <CheckReviewContent summary={checkRun.summary} prompt={checkRun.prompt} diff={checkRun.diff_preview} repo={checkRun.repo} headSha={checkRun.head_sha || ''} />
          </div>
        </div>
      </div>
    </div>
  );
}
