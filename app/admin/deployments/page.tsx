'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Deployment {
  id: number;
  event_type: string;
  repo: string;
  action?: string;
  payload?: any;
  source?: string;
  created_at: string;
}

interface PaginatedResult {
  items: Deployment[];
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

export default function DeploymentsPage() {
  const [data, setData] = useState<PaginatedResult>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const fetchPage = async (page: number) => {
    const result = await fetch(`/api/deployments?page=${page}`).then(r => r.json());
    setData(result.items ? result : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  };

  useEffect(() => {
    fetchPage(1).then(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Coolify Deployments ({data.total})</h1>
      
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">App</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Details</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No deployments yet.</td>
              </tr>
            ) : (
              data.items.map((d, idx) => {
                const payload = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
                
                // Get the actual repo (from _source_repo or repo field)
                const actualRepo = payload?._source_repo || d.repo;
                const appName = payload?._app_name || payload?.application_name || d.repo;
                const coolifyUrl = payload?.deployment_url;
                
                // Determine status from event type
                const isSuccess = d.event_type === 'coolify_deployment_success';
                const isFailed = d.event_type === 'coolify_deployment_failed';
                
                return (
                  <tr key={d.id || idx} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                    <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                      {d.created_at ? new Date(d.created_at).toLocaleString() : '-'}
                    </td>
                    <td className="py-3 px-4">
                      {actualRepo && actualRepo.includes('/') ? (
                        <Link href={`/admin/repos/${actualRepo}`} className="text-[var(--accent)] hover:underline">
                          {actualRepo}
                        </Link>
                      ) : (
                        <span className="text-[var(--text-muted)]">{actualRepo || '-'}</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-block px-2 py-1 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded text-xs font-mono">
                        {appName}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {isSuccess ? (
                        <span className="text-[var(--green)]">✅ Success</span>
                      ) : isFailed ? (
                        <span className="text-[var(--red)]">❌ Failed</span>
                      ) : (
                        <span className="text-yellow-600">⏳ {d.action || 'pending'}</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {coolifyUrl ? (
                        <a href={coolifyUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
                          Coolify →
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">-</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} totalPages={data.totalPages} onPageChange={fetchPage} />
    </div>
  );
}
