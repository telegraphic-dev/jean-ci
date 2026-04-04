'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getRepoAdminPath } from '@/lib/admin/repo-links';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface Repo {
  id: number;
  full_name: string;
  installation_id: number;
  pr_review_enabled: boolean;
  feature_sessions_enabled: boolean;
  active_feature_sessions: number;
  last_activity?: string;
}

type SortOrder = 'activity' | 'name';

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return `${Math.floor(diff / 604800000)}w ago`;
}

export default function ReposPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const search = searchParams.get('q') ?? '';
  const [searchInput, setSearchInput] = useState(search);
  const sortOrder = (searchParams.get('sort') as SortOrder) ?? 'activity';
  const filter = searchParams.get('filter') ?? 'enabled'; // Default to enabled

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
    loadRepos();
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

  async function loadRepos() {
    const res = await fetch('/api/repos');
    const data = await res.json();
    setRepos(data);
    setLoading(false);
  }

  async function syncRepos() {
    setSyncing(true);
    await fetch('/api/repos/sync', { method: 'POST' });
    await loadRepos();
    setSyncing(false);
  }

  async function toggleRepoReview(fullName: string, enabled: boolean) {
    await fetch(`/api/repos/${fullName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_review_enabled: enabled }),
    });
    setRepos(repos.map(r => 
      r.full_name === fullName ? { ...r, pr_review_enabled: enabled } : r
    ));
  }

  async function toggleFeatureSessions(fullName: string, enabled: boolean) {
    await fetch(`/api/repos/${fullName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature_sessions_enabled: enabled }),
    });
    setRepos(repos.map(r => 
      r.full_name === fullName ? { ...r, feature_sessions_enabled: enabled } : r
    ));
  }

  const filteredRepos = repos
    .filter(r => {
      const matchesSearch = r.full_name.toLowerCase().includes(search.toLowerCase());
      const matchesFilter = filter === 'all' ? true : r.pr_review_enabled;
      return matchesSearch && matchesFilter;
    })
    .sort((a, b) => {
      if (sortOrder === 'activity') {
        // Sort by last activity (most recent first), repos without activity at the end
        const aTime = a.last_activity ? new Date(a.last_activity).getTime() : 0;
        const bTime = b.last_activity ? new Date(b.last_activity).getTime() : 0;
        return bTime - aTime;
      } else {
        return a.full_name.localeCompare(b.full_name);
      }
    });

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Repositories ({filteredRepos.length})</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Manage repo-level PR reviews and feature-session trees
          </p>
        </div>
        <button
          onClick={syncRepos}
          disabled={syncing}
          className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50 flex items-center gap-2"
        >
          {syncing ? '⏳ Syncing...' : '🔄 Sync Repos'}
        </button>
      </div>

      {/* Filters and Sort */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="flex gap-2">
          <Link
            href="/admin/repos?filter=enabled"
            className={`px-3 py-1.5 rounded-lg text-sm ${filter === 'enabled' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            Enabled
          </Link>
          <Link
            href="/admin/repos?filter=all"
            className={`px-3 py-1.5 rounded-lg text-sm ${filter === 'all' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            All
          </Link>
        </div>

        <div className="h-4 w-px bg-[var(--border)]" />

        <div className="flex gap-2">
          <button
            onClick={() => updateQuery({ sort: 'activity' })}
            className={`px-3 py-1.5 rounded-lg text-sm ${sortOrder === 'activity' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            Recent Activity
          </button>
          <button
            onClick={() => updateQuery({ sort: 'name' })}
            className={`px-3 py-1.5 rounded-lg text-sm ${sortOrder === 'name' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
          >
            Name
          </button>
        </div>

        <div className="flex-1" />

        <input
          type="text"
          placeholder="Search repos..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm w-64"
        />
      </div>

      {/* Repos table */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
        <table className="w-full min-w-[920px]">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Feature Sessions</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Last Activity</th>
              <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">PR Review</th>
              <th className="text-right py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {filteredRepos.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">
                  {filter === 'enabled' ? 'No repos enabled yet.' : 'No repos found.'}
                </td>
              </tr>
            ) : (
              filteredRepos.map(repo => (
                <tr key={repo.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4">
                    <Link href={getRepoAdminPath(repo.full_name)} className="text-[var(--accent)] hover:underline font-medium">
                      {repo.full_name}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <span className={repo.feature_sessions_enabled ? 'text-[var(--green)]' : 'text-[var(--text-muted)]'}>
                        {repo.feature_sessions_enabled ? '🌳' : '⚪'}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">{repo.active_feature_sessions}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-[var(--text-muted)]">
                    {repo.last_activity ? formatRelativeTime(repo.last_activity) : '—'}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <span className={repo.pr_review_enabled ? 'text-[var(--green)]' : 'text-[var(--text-muted)]'}>
                      {repo.pr_review_enabled ? '✅' : '⚪'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => toggleFeatureSessions(repo.full_name, !repo.feature_sessions_enabled)}
                        className={`px-3 py-1 rounded text-xs ${
                          repo.feature_sessions_enabled
                            ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                            : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
                        }`}
                      >
                        {repo.feature_sessions_enabled ? 'Disable Sessions' : 'Enable Sessions'}
                      </button>
                      <button
                        onClick={() => toggleRepoReview(repo.full_name, !repo.pr_review_enabled)}
                        className={`px-3 py-1 rounded text-xs ${
                          repo.pr_review_enabled
                            ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                            : 'bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20'
                        }`}
                      >
                        {repo.pr_review_enabled ? 'Disable Review' : 'Enable Review'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
