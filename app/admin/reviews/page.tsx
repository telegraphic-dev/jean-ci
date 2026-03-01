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

interface PaginatedResult {
  items: CheckRun[];
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

export default function ReviewsPage() {
  const [data, setData] = useState<PaginatedResult>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const fetchPage = async (page: number) => {
    const result = await fetch(`/api/checks?page=${page}`).then(r => r.json());
    setData(result.items ? result : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  };

  useEffect(() => {
    fetchPage(1).then(() => setLoading(false));
  }, []);

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
      <h1 className="text-2xl font-bold mb-6">All PR Reviews ({data.total})</h1>
      
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
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
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No PR reviews yet.</td>
              </tr>
            ) : (
              data.items.map(c => (
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
      <Pagination page={data.page} totalPages={data.totalPages} onPageChange={fetchPage} />
    </div>
  );
}
