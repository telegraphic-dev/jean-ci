'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getRepoAdminPath } from '@/lib/admin/repo-links';

interface FeatureSession {
  id: number;
  session_key: string;
  repo_full_name: string;
  title: string;
  branch_name?: string | null;
  status: string;
  session_url?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  last_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

function formatRelativeTime(timestamp?: string | null): string {
  if (!timestamp) return '—';
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / 604_800_000)}w ago`;
}

export default function FeatureSessionsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<FeatureSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = searchParams.get('q') || '';
  const [searchInput, setSearchInput] = useState(search);

  const updateQuery = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  useEffect(() => {
    let cancelled = false;

    const loadSessions = async () => {
      try {
        const response = await fetch('/api/feature-sessions');
        if (!response.ok) {
          throw new Error(`request failed with status ${response.status}`);
        }

        const data: unknown = await response.json();
        if (!cancelled) {
          setSessions(Array.isArray(data) ? data as FeatureSession[] : []);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setSessions([]);
          setError('Failed to load feature sessions.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    const next = searchInput.trim();
    const current = search.trim();
    if (next === current) return;

    const timeout = setTimeout(() => {
      updateQuery({ q: next || null });
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchInput, search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter(session => {
      if (!q) return true;
      return [session.repo_full_name, session.title, session.branch_name || '', session.session_key]
        .some(value => value.toLowerCase().includes(q));
    });
  }, [sessions, search]);

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Feature Sessions ({filtered.length})</h1>
          <p className="text-[var(--text-secondary)] mt-1">Global overview of repo-bound feature sessions</p>
        </div>
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm w-full sm:w-72"
        />
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
        {error ? (
          <div className="p-6 text-red-400">{error}</div>
        ) : (
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Title</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Branch</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Last Activity</th>
                <th className="text-right py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Links</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No feature sessions tracked yet.</td>
                </tr>
              ) : filtered.map(session => (
                <tr key={session.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4">
                    <Link href={getRepoAdminPath(session.repo_full_name)} className="text-[var(--accent)] hover:underline font-medium">
                      {session.repo_full_name}
                    </Link>
                  </td>
                  <td className="py-3 px-4">{session.title}</td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">{session.branch_name || '—'}</td>
                  <td className="py-3 px-4">
                    <span className="px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{session.status}</span>
                  </td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">{formatRelativeTime(session.last_activity_at || session.updated_at || session.created_at)}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-3">
                      {session.session_url && <a href={session.session_url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">Session</a>}
                      {session.pr_url && <a href={session.pr_url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">PR</a>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
