'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

interface Repo {
  id: number;
  full_name: string;
  installation_id: number;
  pr_review_enabled: boolean;
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const searchParams = useSearchParams();
  const filter = searchParams.get('filter');

  useEffect(() => {
    loadRepos();
  }, []);

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

  async function toggleRepo(fullName: string, enabled: boolean) {
    await fetch(`/api/repos/${fullName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_review_enabled: enabled }),
    });
    setRepos(repos.map(r => 
      r.full_name === fullName ? { ...r, pr_review_enabled: enabled } : r
    ));
  }

  const filteredRepos = repos.filter(r => {
    const matchesSearch = r.full_name.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'enabled' ? r.pr_review_enabled : true;
    return matchesSearch && matchesFilter;
  });

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Repositories</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            {repos.length} repositories • {repos.filter(r => r.pr_review_enabled).length} with PR reviews enabled
          </p>
        </div>
        <button
          onClick={syncRepos}
          disabled={syncing}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] px-4 py-2 rounded-lg font-medium hover:bg-[var(--border)] transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          <span className={syncing ? 'animate-spin' : ''}>🔄</span>
          {syncing ? 'Syncing...' : 'Sync Repos'}
        </button>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search repositories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md px-4 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        <Link
          href="/admin/repos"
          className={`px-3 py-1.5 rounded-lg text-sm ${!filter ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
        >
          All ({repos.length})
        </Link>
        <Link
          href="/admin/repos?filter=enabled"
          className={`px-3 py-1.5 rounded-lg text-sm ${filter === 'enabled' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
        >
          Enabled ({repos.filter(r => r.pr_review_enabled).length})
        </Link>
      </div>

      {/* Repository list */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">PR Reviews</th>
              <th className="text-right py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {filteredRepos.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-8 text-center text-[var(--text-muted)]">
                  {search ? 'No repositories match your search.' : 'No repositories found.'}
                </td>
              </tr>
            ) : (
              filteredRepos.map(r => (
                <tr key={r.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4">
                    <Link href={`/admin/repos/${r.full_name}`} className="font-medium hover:text-[var(--accent)]">
                      {r.full_name}
                    </Link>
                  </td>
                  <td className="py-3 px-4">
                    <button 
                      onClick={() => toggleRepo(r.full_name, !r.pr_review_enabled)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                        r.pr_review_enabled 
                          ? 'bg-[var(--green)]/10 text-[var(--green)] border border-[var(--green)]/20 hover:bg-[var(--green)]/20' 
                          : 'bg-[var(--red)]/10 text-[var(--red)] border border-[var(--red)]/20 hover:bg-[var(--red)]/20'
                      }`}
                    >
                      {r.pr_review_enabled ? '✅ Enabled' : '❌ Disabled'}
                    </button>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Link 
                      href={`/admin/repos/${r.full_name}`}
                      className="text-[var(--accent)] hover:underline"
                    >
                      Details →
                    </Link>
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
