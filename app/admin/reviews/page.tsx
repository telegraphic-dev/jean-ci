'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface CheckRun {
  id: number;
  github_check_id?: number;
  repo: string;
  pr_number: number;
  check_name: string;
  status: string;
  conclusion?: string;
  title?: string;
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

export default function ReviewsPage() {
  const [prs, setPRs] = useState<PaginatedResult<OpenPR>>({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  const [reviews, setReviews] = useState<PaginatedResult<CheckRun>>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const fetchPRs = async (page: number) => {
    const result = await fetch(`/api/prs?page=${page}`).then(r => r.json());
    setPRs(result.items ? result : { items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  };

  const fetchReviews = async (page: number) => {
    const result = await fetch(`/api/checks?page=${page}`).then(r => r.json());
    setReviews(result.items ? result : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  };

  useEffect(() => {
    Promise.all([fetchPRs(1), fetchReviews(1)]).then(() => setLoading(false));
  }, []);

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
    <div>
      {/* Open PRs Section */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-4">Open Pull Requests ({prs.total})</h1>
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
                      <Link href={`/admin/repos/${pr.repo}`} className="text-[var(--accent)] hover:underline">
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
        <Pagination page={prs.page} totalPages={prs.totalPages} onPageChange={fetchPRs} />
        
        <div className="mt-3 text-sm text-[var(--text-muted)] flex items-center gap-4">
          <span>Legend:</span>
          <span className="flex items-center gap-1"><span className="text-[var(--green)]">✅</span> Ready to merge</span>
          <span className="flex items-center gap-1"><span className="text-[var(--red)]">❌</span> Failed checks</span>
          <span className="flex items-center gap-1"><span className="text-yellow-500">⌛</span> Pending checks</span>
        </div>
      </div>

      {/* Reviews History Section */}
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
              </tr>
            </thead>
            <tbody className="text-sm">
              {reviews.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No PR reviews yet.</td>
                </tr>
              ) : (
                reviews.items.map(c => (
                  <tr key={c.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                    <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                      {new Date(c.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <Link href={`/admin/repos/${c.repo}`} className="text-[var(--accent)] hover:underline">
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
                      {c.title || '-'}
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={reviews.page} totalPages={reviews.totalPages} onPageChange={fetchReviews} />
      </div>
    </div>
  );
}
