'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface PipelineStage {
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped';
  timestamp?: string;
  url?: string;
}

interface Pipeline {
  sha: string;
  shortSha: string;
  repo: string;
  message?: string;
  author?: string;
  build: PipelineStage;
  package: PipelineStage;
  deploy: PipelineStage;
  createdAt: string;
}

interface PaginatedResult {
  items: Pipeline[];
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

function StageCell({ stage, label }: { stage: PipelineStage; label: string }) {
  const getStatusBadge = () => {
    switch (stage.status) {
      case 'success':
        return <span className="text-[var(--green)]">✅</span>;
      case 'failure':
        return <span className="text-[var(--red)]">❌</span>;
      case 'running':
        return <span className="text-yellow-500 animate-pulse">⏳</span>;
      case 'pending':
        return <span className="text-[var(--text-muted)]">⚪</span>;
      case 'skipped':
        return <span className="text-[var(--text-muted)]">➖</span>;
    }
  };

  const content = (
    <div className="flex items-center gap-1.5">
      {getStatusBadge()}
      {stage.timestamp && (
        <span className="text-xs text-[var(--text-muted)]">
          {formatRelativeTime(stage.timestamp)}
        </span>
      )}
    </div>
  );

  if (stage.url) {
    return (
      <a href={stage.url} target="_blank" rel="noopener noreferrer" className="hover:bg-[var(--bg-secondary)] rounded px-1 -mx-1">
        {content}
      </a>
    );
  }

  return content;
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

export default function DeploymentsPage() {
  const [data, setData] = useState<PaginatedResult>({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const fetchPage = async (page: number) => {
    const result = await fetch(`/api/pipelines?page=${page}`).then(r => r.json());
    if (result.items) {
      setData(result);
    } else if (result.pipelines) {
      // Handle old format
      setData({ items: result.pipelines, total: result.pipelines.length, page: 1, limit: 20, totalPages: 1 });
    } else {
      setData({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
    }
  };

  useEffect(() => {
    fetchPage(1).then(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  const pipelines = data.items;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Deployment Pipelines ({data.total})</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Build → Package → Deploy progress per commit
          </p>
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Commit</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Build</th>
              <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Package</th>
              <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Deploy</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {pipelines.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No deployment pipelines yet.</td>
              </tr>
            ) : (
              pipelines.map((p, idx) => (
                <tr key={`${p.repo}:${p.sha}`} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex flex-col">
                      <a 
                        href={`https://github.com/${p.repo}/commit/${p.sha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[var(--accent)] hover:underline"
                      >
                        {p.shortSha}
                      </a>
                      {p.message && (
                        <span className="text-xs text-[var(--text-muted)] truncate max-w-[200px]" title={p.message}>
                          {p.message}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <Link href={`/admin/repos/${p.repo}`} className="text-[var(--accent)] hover:underline">
                      {p.repo}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <StageCell stage={p.build} label="Build" />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <StageCell stage={p.package} label="Package" />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <StageCell stage={p.deploy} label="Deploy" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={data.page} totalPages={data.totalPages} onPageChange={fetchPage} />

      <div className="mt-4 text-sm text-[var(--text-muted)] flex items-center gap-4">
        <span>Legend:</span>
        <span className="flex items-center gap-1"><span className="text-[var(--green)]">✅</span> Success</span>
        <span className="flex items-center gap-1"><span className="text-[var(--red)]">❌</span> Failed</span>
        <span className="flex items-center gap-1"><span className="text-yellow-500">⏳</span> Running</span>
        <span className="flex items-center gap-1"><span>⚪</span> Pending</span>
        <span className="flex items-center gap-1"><span>➖</span> Skipped</span>
      </div>
    </div>
  );
}
