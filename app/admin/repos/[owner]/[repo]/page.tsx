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

interface CheckRun {
  id: number;
  github_check_id?: number;
  repo: string;
  pr_number: number;
  check_name: string;
  status: string;
  conclusion?: string;
  title?: string;
  created_at: string;
  completed_at?: string;
}

interface WebhookEvent {
  id: number;
  event_type: string;
  delivery_id: string;
  action?: string;
  payload?: any;
  created_at: string;
}

type Tab = 'checks' | 'deployments' | 'events';

export default function RepoDetailPage() {
  const params = useParams();
  const fullName = `${params.owner}/${params.repo}`;
  const [repo, setRepo] = useState<Repo | null>(null);
  const [checks, setChecks] = useState<CheckRun[]>([]);
  const [deployments, setDeployments] = useState<WebhookEvent[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('checks');

  useEffect(() => {
    Promise.all([
      fetch(`/api/repos/${fullName}`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/checks`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/deployments`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/events`).then(r => r.json()),
    ]).then(([repoData, checksData, deploymentsData, eventsData]) => {
      setRepo(repoData.error ? null : repoData);
      setChecks(Array.isArray(checksData) ? checksData : []);
      setDeployments(Array.isArray(deploymentsData) ? deploymentsData : []);
      setEvents(Array.isArray(eventsData) ? eventsData : []);
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

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'checks', label: 'PR Reviews', count: checks.length },
    { id: 'deployments', label: 'Deployments', count: deployments.length },
    { id: 'events', label: 'All Events', count: events.length },
  ];

  const getStatusBadge = (status: string, conclusion?: string) => {
    if (status === 'completed') {
      if (conclusion === 'success') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--green)]/10 text-[var(--green)]">✅ Passed</span>;
      } else if (conclusion === 'failure') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--red)]/10 text-[var(--red)]">❌ Failed</span>;
      } else if (conclusion === 'skipped') {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--text-muted)]/10 text-[var(--text-muted)]">⏭️ Skipped</span>;
      }
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--text-secondary)]/10">{conclusion || 'Done'}</span>;
    }
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-500/10 text-yellow-600">⏳ {status}</span>;
  };

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

      {/* PR Reviews Tab */}
      {activeTab === 'checks' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">PR</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Check</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Title</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {checks.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No PR reviews yet.</td>
                </tr>
              ) : (
                checks.map(c => (
                  <tr key={c.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                    <td className="py-3 px-4">
                      <a 
                        href={`https://github.com/${fullName}/pull/${c.pr_number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent)] hover:underline font-medium"
                      >
                        #{c.pr_number}
                      </a>
                    </td>
                    <td className="py-3 px-4">
                      <Link href={`/checks/${c.id}`} className="text-[var(--accent)] hover:underline">
                        {c.check_name || 'jean-ci'}
                      </Link>
                      {c.github_check_id && (
                        <a 
                          href={`https://github.com/${fullName}/runs/${c.github_check_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-xs text-[var(--text-muted)] hover:text-[var(--accent)]"
                        >
                          (GitHub →)
                        </a>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(c.status, c.conclusion)}
                    </td>
                    <td className="py-3 px-4 text-[var(--text-secondary)] max-w-xs truncate">
                      {c.title || '-'}
                    </td>
                    <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                      {new Date(c.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Deployments Tab */}
      {activeTab === 'deployments' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Type</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Details</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {deployments.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[var(--text-muted)]">No deployments yet.</td>
                </tr>
              ) : (
                deployments.map(d => {
                  const payload = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
                  // Construct proper GitHub web URLs (not API URLs)
                  let deploymentUrl: string | undefined;
                  if (payload?.workflow_run?.html_url) {
                    deploymentUrl = payload.workflow_run.html_url;
                  } else if (payload?.check_run?.html_url) {
                    deploymentUrl = payload.check_run.html_url;
                  } else if (payload?.deployment?.id && payload?.repository?.full_name) {
                    deploymentUrl = `https://github.com/${payload.repository.full_name}/deployments/${payload.deployment.id}`;
                  } else if (d.event_type === 'registry_package' && payload?.registry_package?.html_url) {
                    deploymentUrl = payload.registry_package.html_url;
                  }
                  const status = d.action || payload?.deployment_status?.state || 'unknown';
                  
                  return (
                    <tr key={d.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                        {new Date(d.created_at).toLocaleString()}
                      </td>
                      <td className="py-3 px-4">
                        <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                          {d.event_type}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {status === 'success' ? (
                          <span className="text-[var(--green)]">✅ Success</span>
                        ) : status === 'failure' || status === 'error' ? (
                          <span className="text-[var(--red)]">❌ Failed</span>
                        ) : status === 'pending' || status === 'in_progress' ? (
                          <span className="text-yellow-600">⏳ {status}</span>
                        ) : (
                          <span className="text-[var(--text-secondary)]">{status}</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {deploymentUrl && (
                          <a 
                            href={deploymentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--accent)] hover:underline"
                          >
                            View on GitHub →
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* All Events Tab */}
      {activeTab === 'events' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Event</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Delivery ID</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {events.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[var(--text-muted)]">No events yet.</td>
                </tr>
              ) : (
                events.map(e => (
                  <tr key={e.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                    <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                        {e.event_type}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-[var(--text-secondary)]">
                      {e.action || '-'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">
                      {e.delivery_id?.slice(0, 8)}...
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
