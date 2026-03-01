'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Event {
  id: number;
  event_type: string;
  delivery_id?: string;
  repo?: string;
  action?: string;
  source?: string;
  pr_number?: number;
  created_at: string;
}

interface PaginatedResult {
  items: Event[];
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

export default function EventsPage() {
  const [data, setData] = useState<PaginatedResult>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  const fetchPage = async (page: number) => {
    const result = await fetch(`/api/events?page=${page}`).then(r => r.json());
    // Handle both old array format and new paginated format
    if (Array.isArray(result)) {
      setData({ items: result, total: result.length, page: 1, limit: result.length, totalPages: 1 });
    } else if (result.items) {
      setData(result);
    } else {
      setData({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    }
  };

  useEffect(() => {
    fetchPage(1).then(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  const events = data.items;
  const eventTypes = [...new Set(events.map(e => e.event_type))];
  const filteredEvents = filter ? events.filter(e => e.event_type === filter) : events;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Events ({data.total})</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Recent webhook events from GitHub and Coolify
          </p>
        </div>
      </div>

      {/* Filter by event type */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => setFilter('')}
          className={`px-3 py-1.5 rounded-lg text-sm ${!filter ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
        >
          All ({events.length})
        </button>
        {eventTypes.map(type => (
          <button
            key={type}
            onClick={() => setFilter(type)}
            className={`px-3 py-1.5 rounded-lg text-sm ${filter === type ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            {type} ({events.filter(e => e.event_type === type).length})
          </button>
        ))}
      </div>

      {/* Events table */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Event</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Source</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {filteredEvents.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No events yet.</td>
              </tr>
            ) : (
              filteredEvents.map(e => (
                <tr key={e.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="py-3 px-4">
                    <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                      {e.event_type}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {e.repo && e.repo.includes('/') ? (
                      <Link href={`/admin/repos/${e.repo}`} className="text-[var(--accent)] hover:underline">
                        {e.repo}
                      </Link>
                    ) : (
                      <span className="text-[var(--text-muted)]">{e.repo || '-'}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-[var(--text-secondary)]">{e.action || '-'}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                      e.source === 'coolify' ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'
                    }`}>
                      {e.source || 'github'}
                    </span>
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
