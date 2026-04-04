'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getRepoAdminPath } from '@/lib/admin/repo-links';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface CheckRun {
  id: number;
  github_check_id?: number;
  repo: string;
  pr_number: number;
  check_name: string;
  status: string;
  conclusion?: string;
  title?: string;
  manually_overridden?: boolean;
  override_reason?: string;
  overridden_by?: string;
  overridden_at?: string;
  created_at: string;
  completed_at?: string;
}

interface OpenPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  url: string;
  checkStatus: 'pending' | 'success' | 'failure';
  updatedAt: string;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type ReviewsSection = 'open' | 'history';

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 mt-4">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
      >
        ← Prev
      </button>
      <span className="text-sm text-[var(--text-secondary)]">
        Page {page} of {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
      >
        Next →
      </button>
    </div>
  );
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function ReviewsContent({ section }: { section: ReviewsSection }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [prs, setPRs] = useState<PaginatedResult<OpenPR>>({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  const [reviews, setReviews] = useState<PaginatedResult<CheckRun>>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [overrideLoadingId, setOverrideLoadingId] = useState<number | null>(null);

  const pageParam = Number(searchParams.get('page') || '1');
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const updateQuery = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const buildSectionHref = (targetSection: ReviewsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    const query = params.toString();
    const base = `/admin/reviews/${targetSection}`;
    return query ? `${base}?${query}` : base;
  };

  const fetchPRs = async (targetPage: number) => {
    const result = await fetch(`/api/prs?page=${targetPage}`).then(r => r.json());
    setPRs(result.items ? result : { items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  };

  const fetchReviews = async (targetPage: number) => {
    const result = await fetch(`/api/checks?page=${targetPage}`).then(r => r.json());
    setReviews(result.items ? result : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  };

  useEffect(() => {
    setLoading(true);
    const load = section === 'open' ? fetchPRs(page) : fetchReviews(page);
    Promise.resolve(load).then(() => setLoading(false));
  }, [page, section]);

  const overrideToPass = async (check: CheckRun) => {
    const reason = window.prompt(`Why are you overriding ${check.repo}#${check.pr_number} / ${check.check_name} to PASS?`);
    if (!reason || !reason.trim()) return;

    setOverrideLoadingId(check.id);
    try {
      const res = await fetch(`/api/checks/${check.id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Override failed');
      }

      await fetchReviews(reviews.page);
    } catch (error: any) {
      window.alert(error.message || 'Override failed');
    } finally {
      setOverrideLoadingId(null);
    }
  };

  const getCheckStatusIcon = (status: 'pending' | 'success' | 'failure') => {
    switch (status) {
      case 'success': return <span className="text-[var(--green)]">✅</span>;
      case 'failure': return <span className="text-[var(--red)]">❌</span>;
      case 'pending': return <span className="text-yellow-500">⌛</span>;
    }
  };

  const getStatusBadge = (status: string, conclusion?: string) => {
    if (status === 'completed') {
      if (conclusion === 'success') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--green)]/10 text-[var(--green)]">✅ Passed</span>;
      } else if (conclusion === 'failure') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--red)]/10 text-[var(--red)]">❌ Failed</span>;
      } else if (conclusion === 'skipped') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--text-muted)]/10 text-[var(--text-muted)]">⏭️ Skipped</span>;
      }
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--text-secondary)]/10">{conclusion || 'Done'}</span>;
    }
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-500/10 text-yellow-600">⏳ {status}</span>;
  };

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Reviews</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Open pull requests and historical review runs split into dedicated views.
          </p>
        </div>
        <div className="flex bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden w-fit">
          <Link
            href={buildSectionHref('open')}
            className={`px-3 py-1.5 text-sm ${section === 'open' ? 'bg-blue-500 text-white' : ''}`}
          >
            Open PRs
          </Link>
          <Link
            href={buildSectionHref('history')}
            className={`px-3 py-1.5 text-sm ${section === 'history' ? 'bg-blue-500 text-white' : ''}`}
          >
            History
          </Link>
        </div>
      </div>

      {section === 'open' ? (
        <div>
          <h2 className="text-xl font-bold mb-4">Open Pull Requests ({prs.total})</h2>
          <p className="text-[var(--text-secondary)] mb-4">PRs in repositories with code review enabled</p>

          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)] w-16">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Title</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">PR</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Author</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Updated</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {prs.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No open PRs found.</td>
                  </tr>
                ) : (
                  prs.items.map(pr => (
                    <tr key={`${pr.repo}-${pr.number}`} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4 text-center text-lg">
                        {getCheckStatusIcon(pr.checkStatus)}
                      </td>
                      <td className="py-3 px-4 max-w-xs" title={pr.title}>
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-[var(--accent)] hover:underline font-medium"
                        >
                          {pr.title}
                        </a>
                      </td>
                      <td className="py-3 px-4">
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] hover:underline font-medium"
                        >
                          #{pr.number}
                        </a>
                        <span className="ml-2 text-xs text-[var(--text-muted)] font-mono">{pr.headSha}</span>
                      </td>
                      <td className="py-3 px-4">
                        <Link href={getRepoAdminPath(pr.repo)} className="text-[var(--accent)] hover:underline">
                          {pr.repo}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-[var(--text-muted)]">
                        {pr.author}
                      </td>
                      <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                        {formatRelativeTime(pr.updatedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={prs.page} totalPages={prs.totalPages} onPageChange={(nextPage) => updateQuery({ page: String(nextPage) })} />

          <div className="mt-3 text-sm text-[var(--text-muted)] flex items-center gap-4">
            <span>Legend:</span>
            <span className="flex items-center gap-1"><span className="text-[var(--green)]">✅</span> Ready to merge</span>
            <span className="flex items-center gap-1"><span className="text-[var(--red)]">❌</span> Failed checks</span>
            <span className="flex items-center gap-1"><span className="text-yellow-500">⌛</span> Pending checks</span>
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-xl font-bold mb-4">Review History ({reviews.total})</h2>

          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">PR</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Title</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Details</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Actions</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {reviews.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">No PR reviews yet.</td>
                  </tr>
                ) : (
                  reviews.items.map(c => (
                    <tr key={c.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                        {new Date(c.created_at).toLocaleString()}
                      </td>
                      <td className="py-3 px-4">
                        <Link href={getRepoAdminPath(c.repo)} className="text-[var(--accent)] hover:underline">
                          {c.repo}
                        </Link>
                      </td>
                      <td className="py-3 px-4">
                        <a
                          href={`https://github.com/${c.repo}/pull/${c.pr_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] hover:underline font-medium"
                        >
                          #{c.pr_number}
                        </a>
                      </td>
                      <td className="py-3 px-4">
                        {getStatusBadge(c.status, c.conclusion)}
                      </td>
                      <td className="py-3 px-4 text-[var(--text-secondary)] max-w-xs truncate">
                        <div>{c.title || '-'}</div>
                        {c.manually_overridden && (
                          <div className="mt-1 text-xs text-amber-600">
                            Manually overridden by {c.overridden_by || 'admin'}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <Link href={`/checks/${c.id}`} className="text-[var(--accent)] hover:underline">
                          View Details →
                        </Link>
                        {c.github_check_id && (
                          <a
                            href={`https://github.com/${c.repo}/runs/${c.github_check_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 text-xs text-[var(--text-muted)] hover:text-[var(--accent)]"
                          >
                            (GitHub)
                          </a>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {c.status === 'completed' && c.conclusion === 'failure' && !c.manually_overridden ? (
                          <button
                            onClick={() => overrideToPass(c)}
                            disabled={overrideLoadingId === c.id}
                            className="px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {overrideLoadingId === c.id ? 'Overriding…' : 'Override to PASS'}
                          </button>
                        ) : c.manually_overridden ? (
                          <span className="text-xs text-amber-600">Overridden</span>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={reviews.page} totalPages={reviews.totalPages} onPageChange={(nextPage) => updateQuery({ page: String(nextPage) })} />
        </div>
      )}
    </div>
  );
}
