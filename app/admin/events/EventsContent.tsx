'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getRepoAdminPath } from '@/lib/admin/repo-links';

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

interface EventDetail {
  event: Event;
  payload: any;
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

function PayloadModal({ eventId, onClose }: { eventId: number; onClose: () => void }) {
  const [data, setData] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/events/${eventId}`)
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          setError(result.error);
        } else {
          setData(result);
        }
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [eventId]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold">Event Payload</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-4 overflow-auto flex-1">
          {loading && <div className="text-center text-[var(--text-muted)]">Loading...</div>}
          {error && <div className="text-center text-[var(--red)]">Error: {error}</div>}
          {data && (
            <div>
              <div className="mb-4 flex flex-wrap gap-2 text-sm">
                <span className="px-2 py-1 bg-[var(--bg-secondary)] rounded">
                  <strong>Type:</strong> {data.event.event_type}
                </span>
                <span className="px-2 py-1 bg-[var(--bg-secondary)] rounded">
                  <strong>Action:</strong> {data.event.action || '-'}
                </span>
                <span className="px-2 py-1 bg-[var(--bg-secondary)] rounded">
                  <strong>Repo:</strong> {data.event.repo || '-'}
                </span>
                <span className="px-2 py-1 bg-[var(--bg-secondary)] rounded">
                  <strong>Source:</strong> {data.event.source || 'github'}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] mb-2">
                ⚠️ Sensitive fields (tokens, secrets, emails, etc.) are masked
              </div>
              <pre className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4 text-xs font-mono overflow-auto max-h-[50vh] whitespace-pre-wrap">
                {JSON.stringify(data.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EventsContent({ eventType }: { eventType?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [data, setData] = useState<PaginatedResult>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

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

  const buildTypeHref = (type?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    const query = params.toString();
    const base = type ? `/admin/events/type/${encodeURIComponent(type)}` : '/admin/events';
    return query ? `${base}?${query}` : base;
  };

  const fetchPage = async (targetPage: number, targetType?: string) => {
    let url = `/api/events?page=${targetPage}`;
    if (targetType) {
      url += `&eventType=${encodeURIComponent(targetType)}`;
    }
    const result = await fetch(url).then(r => r.json());
    if (result.items) {
      setData(result);
    } else {
      setData({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    }
  };

  const fetchEventTypes = async () => {
    const result = await fetch('/api/events', { method: 'OPTIONS' }).then(r => r.json());
    if (result.types) {
      setEventTypes(result.types);
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPage(page, eventType), fetchEventTypes()]).then(() => setLoading(false));
  }, [page, eventType]);

  const handlePageChange = (targetPage: number) => {
    updateQuery({ page: String(targetPage) });
  };

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

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

      <div className="flex flex-wrap gap-2 mb-6">
        <Link
          href={buildTypeHref()}
          className={`px-3 py-1.5 rounded-lg text-sm ${!eventType ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
        >
          All
        </Link>
        {eventTypes.map(type => (
          <Link
            key={type}
            href={buildTypeHref(type)}
            className={`px-3 py-1.5 rounded-lg text-sm ${eventType === type ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            {type}
          </Link>
        ))}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Event</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Source</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Payload</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No events found.</td>
              </tr>
            ) : (
              data.items.map(e => (
                <tr key={e.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="py-3 px-4">
                    <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                      {e.event_type}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {e.repo && e.repo.includes('/') ? (
                      <Link href={getRepoAdminPath(e.repo)} className="text-[var(--accent)] hover:underline">
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
                  <td className="py-3 px-4">
                    <button
                      onClick={() => setSelectedEventId(e.id)}
                      className="text-[var(--accent)] hover:underline text-sm"
                    >
                      View →
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} totalPages={data.totalPages} onPageChange={handlePageChange} />

      {selectedEventId && (
        <PayloadModal eventId={selectedEventId} onClose={() => setSelectedEventId(null)} />
      )}
    </div>
  );
}
