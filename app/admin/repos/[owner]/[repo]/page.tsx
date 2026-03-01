'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Repo {
  id: number;
  full_name: string;
  installation_id: number;
  pr_review_enabled: boolean;
}

interface Event {
  id: number;
  event_type: string;
  action?: string;
  pr_number?: number;
  created_at: string;
}

type Tab = 'events' | 'deployments' | 'reviews';

export default function RepoDetailPage() {
  const params = useParams();
  const fullName = `${params.owner}/${params.repo}`;
  const [repo, setRepo] = useState<Repo | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('events');

  useEffect(() => {
    Promise.all([
      fetch(`/api/repos/${fullName}`).then(r => r.json()),
      fetch(`/api/events?repo=${fullName}`).then(r => r.json()),
    ]).then(([repoData, eventsData]) => {
      setRepo(repoData);
      setEvents(eventsData);
      setLoading(false);
    });
  }, [fullName]);

  async function toggleRepo(enabled: boolean) {
    await fetch(`/api/repos/${fullName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_review_enabled: enabled }),
    });
    setRepo(repo ? { ...repo, pr_review_enabled: enabled } : null);
  }

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  if (!repo) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--text-muted)]">Repository not found</p>
        <Link href="/admin/repos" className="text-[var(--accent)] hover:underline mt-2 inline-block">
          ← Back to repositories
        </Link>
      </div>
    );
  }

  const deploymentEvents = events.filter(e => e.event_type === 'deployment_status' || e.event_type === 'registry_package');
  const reviewEvents = events.filter(e => e.event_type === 'pull_request' || e.event_type === 'check_run');

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'events', label: 'All Events', count: events.length },
    { id: 'deployments', label: 'Deployments', count: deploymentEvents.length },
    { id: 'reviews', label: 'PR Reviews', count: reviewEvents.length },
  ];

  const displayEvents = activeTab === 'deployments' ? deploymentEvents 
    : activeTab === 'reviews' ? reviewEvents 
    : events;

  return (
    <div>
      {/* Breadcrumb */}
      <div className="text-sm text-[var(--text-muted)] mb-4">
        <Link href="/admin/repos" className="hover:text-[var(--accent)]">Repositories</Link>
        <span className="mx-2">›</span>
        <span>{fullName}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">{fullName}</h1>
          <a 
            href={`https://github.com/${fullName}`} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-sm text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            View on GitHub →
          </a>
        </div>
        <button 
          onClick={() => toggleRepo(!repo.pr_review_enabled)}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            repo.pr_review_enabled 
              ? 'bg-[var(--green)]/10 text-[var(--green)] border border-[var(--green)]/20 hover:bg-[var(--green)]/20' 
              : 'bg-[var(--red)]/10 text-[var(--red)] border border-[var(--red)]/20 hover:bg-[var(--red)]/20'
          }`}
        >
          {repo.pr_review_enabled ? '✅ PR Reviews Enabled' : '❌ PR Reviews Disabled'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-[var(--border)]">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tab.label} ({tab.count})
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
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Details</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {displayEvents.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-[var(--text-muted)]">No events yet.</td>
              </tr>
            ) : (
              displayEvents.slice(0, 50).map(e => (
                <tr key={e.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="py-3 px-4 text-[var(--text-muted)]">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="py-3 px-4">
                    <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                      {e.event_type}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-[var(--text-secondary)]">{e.action || '-'}</td>
                  <td className="py-3 px-4 text-[var(--text-secondary)]">
                    {e.pr_number && (
                      <a 
                        href={`https://github.com/${fullName}/pull/${e.pr_number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent)] hover:underline"
                      >
                        PR #{e.pr_number}
                      </a>
                    )}
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
