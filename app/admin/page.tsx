'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Stats {
  totalRepos: number;
  enabledRepos: number;
  recentEvents: number;
  openPRs: number;
  pendingDeploys: number;
  totalTasks: number;
  failedTasks24h: number;
}

export default function AdminOverview() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/repos').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/tasks/stats').then(r => r.json()).catch(() => ({ stats: { total: 0, last_24h_failures: 0 } })),
    ]).then(([repos, events, dashStats, taskStats]) => {
      setStats({
        totalRepos: repos.length,
        enabledRepos: repos.filter((r: any) => r.pr_review_enabled).length,
        recentEvents: events.length,
        openPRs: dashStats.openPRs,
        pendingDeploys: dashStats.pendingDeploys,
        totalTasks: taskStats.stats?.total || 0,
        failedTasks24h: taskStats.stats?.last_24h_failures || 0,
      });
    });
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
        <Link href="/admin/reviews" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">🔀</div>
          <div className="text-3xl font-bold text-[var(--blue)]">{stats?.openPRs ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Open PRs</div>
        </Link>
        
        <Link href="/admin/deployments" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">🚀</div>
          <div className="text-3xl font-bold text-[var(--yellow)]">{stats?.pendingDeploys ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Pending Deploys</div>
        </Link>
        
        <Link href="/admin/repos" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📦</div>
          <div className="text-3xl font-bold">{stats?.totalRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Repositories</div>
        </Link>
        
        <Link href="/admin/repos?filter=enabled" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">✅</div>
          <div className="text-3xl font-bold text-[var(--green)]">{stats?.enabledRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Reviews Enabled</div>
        </Link>
        
        <Link href="/admin/events" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📋</div>
          <div className="text-3xl font-bold">{stats?.recentEvents ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Events</div>
        </Link>
        
        <Link href="/admin/tasks" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">⏰</div>
          <div className="text-3xl font-bold">{stats?.totalTasks ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Tasks {stats?.failedTasks24h ? <span className="text-[var(--red)]">({stats.failedTasks24h} failed)</span> : ''}</div>
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
