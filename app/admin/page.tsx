'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Stats {
  totalRepos: number;
  enabledRepos: number;
  recentEvents: number;
}

export default function AdminOverview() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/repos').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
    ]).then(([repos, events]) => {
      setStats({
        totalRepos: repos.length,
        enabledRepos: repos.filter((r: any) => r.pr_review_enabled).length,
        recentEvents: events.length,
      });
    });
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      
      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <Link href="/admin/repos" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📦</div>
          <div className="text-3xl font-bold">{stats?.totalRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Total Repositories</div>
        </Link>
        
        <Link href="/admin/repos?filter=enabled" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">✅</div>
          <div className="text-3xl font-bold text-[var(--green)]">{stats?.enabledRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">PR Reviews Enabled</div>
        </Link>
        
        <Link href="/admin/events" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📋</div>
          <div className="text-3xl font-bold">{stats?.recentEvents ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Recent Events</div>
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
          <div className="space-y-2">
            <Link href="/admin/prompt" className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors">
              <span className="text-xl">📝</span>
              <div>
                <div className="font-medium">Edit Review Prompt</div>
                <div className="text-sm text-[var(--text-secondary)]">Customize the LLM review criteria</div>
              </div>
            </Link>
            <Link href="/admin/repos" className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors">
              <span className="text-xl">🔄</span>
              <div>
                <div className="font-medium">Sync Repositories</div>
                <div className="text-sm text-[var(--text-secondary)]">Refresh from GitHub App installations</div>
              </div>
            </Link>
          </div>
        </div>

        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">System Status</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Health</span>
              <span className="flex items-center gap-2 text-[var(--green)]">
                <span className="w-2 h-2 rounded-full bg-current"></span>
                Healthy
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Version</span>
              <span className="font-mono text-sm">0.13.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
