'use client';

import { useEffect, useState, useCallback } from 'react';
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
  delivery_id?: string;
  action?: string;
  payload?: any;
  source?: string;
  created_at: string;
}

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

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface Counts {
  checks: number;
  deployments: number;
  events: number;
}

interface TaskSummary {
  task_name: string;
  app_uuid: string | null;
  app_name: string | null;
  repo: string | null;
  total_runs: number;
  success_count: number;
  failure_count: number;
  last_run: string;
  last_status: 'success' | 'failure';
  last_output: string | null;
  url: string | null;
}

interface TaskStats {
  total_tasks: number;
  total_runs: number;
  runs_24h: number;
  failures_24h: number;
}

type Tab = 'checks' | 'deployments' | 'tasks' | 'events';

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

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function StageCell({ stage }: { stage: PipelineStage }) {
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

function getStatusBadge(status: string, conclusion?: string | null) {
  if (status === 'completed') {
    if (conclusion === 'success') return <span className="text-[var(--green)]">✅ Passed</span>;
    if (conclusion === 'failure') return <span className="text-[var(--red)]">❌ Failed</span>;
    if (conclusion === 'action_required') return <span className="text-yellow-500">⚠️ Action Required</span>;
    return <span className="text-[var(--text-muted)]">{conclusion}</span>;
  }
  if (status === 'in_progress') return <span className="text-yellow-500">⏳ Running</span>;
  if (status === 'queued') return <span className="text-[var(--text-muted)]">⏸️ Queued</span>;
  return <span className="text-[var(--text-muted)]">{status}</span>;
}

export default function RepoDetailPage() {
  const params = useParams();
  const fullName = `${params.owner}/${params.repo}`;
  const [repo, setRepo] = useState<Repo | null>(null);
  const [counts, setCounts] = useState<Counts>({ checks: 0, deployments: 0, events: 0 });
  const [checks, setChecks] = useState<PaginatedResult<CheckRun>>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [pipelines, setPipelines] = useState<PaginatedResult<Pipeline>>({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  const [events, setEvents] = useState<PaginatedResult<WebhookEvent>>({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
  const [tasks, setTasks] = useState<{ summary: TaskSummary[]; stats: TaskStats | null }>({ summary: [], stats: null });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('checks');
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);

  const fetchData = useCallback(async (checksPage = 1, pipelinesPage = 1, eventsPage = 1) => {
    const [repoData, countsData, checksData, pipelinesData, eventsData, tasksData] = await Promise.all([
      fetch(`/api/repos/${fullName}`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/counts`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/checks?page=${checksPage}`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/pipelines?page=${pipelinesPage}`).then(r => r.json()),
      fetch(`/api/repos/${fullName}/events?page=${eventsPage}`).then(r => r.json()),
      fetch(`/api/tasks?view=summary&repo=${encodeURIComponent(fullName)}`).then(r => r.json()),
    ]);
    setRepo(repoData.error ? null : repoData);
    setCounts(countsData.error ? { checks: 0, deployments: 0, events: 0 } : countsData);
    setChecks(checksData.items ? checksData : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    setPipelines(pipelinesData.items ? pipelinesData : { items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
    setEvents(eventsData.items ? eventsData : { items: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    setTasks({ summary: tasksData.summary || [], stats: tasksData.stats || null });
    setLoading(false);
  }, [fullName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleChecksPageChange = async (page: number) => {
    const data = await fetch(`/api/repos/${fullName}/checks?page=${page}`).then(r => r.json());
    setChecks(data.items ? data : checks);
  };

  const handlePipelinesPageChange = async (page: number) => {
    const data = await fetch(`/api/repos/${fullName}/pipelines?page=${page}`).then(r => r.json());
    setPipelines(data.items ? data : pipelines);
  };

  const handleEventsPageChange = async (page: number) => {
    const data = await fetch(`/api/repos/${fullName}/events?page=${page}`).then(r => r.json());
    setEvents(data.items ? data : events);
  };

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  if (!repo) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--text-muted)]">Repository not found or not configured.</p>
        <Link href="/admin/repos" className="text-[var(--accent)] hover:underline mt-4 inline-block">
          ← Back to repositories
        </Link>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'checks', label: 'PR Reviews', count: counts.checks },
    { id: 'deployments', label: 'Deployments', count: pipelines.total },
    { id: 'tasks', label: 'Scheduled Tasks', count: tasks.summary.length },
    { id: 'events', label: 'All Events', count: counts.events },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-1">
            <Link href="/admin/repos" className="hover:text-[var(--accent)]">Repositories</Link>
            <span>/</span>
          </div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <a 
              href={`https://github.com/${fullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--accent)]"
            >
              {fullName}
            </a>
            <span className={`text-sm px-2 py-0.5 rounded ${repo.pr_review_enabled ? 'bg-[var(--green)]/10 text-[var(--green)]' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)]'}`}>
              {repo.pr_review_enabled ? '✅ Reviews enabled' : 'Reviews disabled'}
            </span>
          </h1>
        </div>
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
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[700px]">
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
                {checks.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No PR reviews yet.</td>
                  </tr>
                ) : (
                  checks.items.map(c => (
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
          <Pagination page={checks.page} totalPages={checks.totalPages} onPageChange={handleChecksPageChange} />
        </div>
      )}

      {/* Deployments Tab - Pipeline View */}
      {activeTab === 'deployments' && (
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Commit</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Build</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Package</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Deploy</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {pipelines.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-[var(--text-muted)]">No deployment pipelines yet.</td>
                  </tr>
                ) : (
                  pipelines.items.map((p) => (
                    <tr key={p.sha} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <a 
                            href={`https://github.com/${fullName}/commit/${p.sha}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[var(--accent)] hover:underline"
                          >
                            {p.shortSha}
                          </a>
                          {p.message && (
                            <span className="text-xs text-[var(--text-muted)] truncate max-w-[250px]" title={p.message}>
                              {p.message}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <StageCell stage={p.build} />
                      </td>
                      <td className="py-3 px-4 text-center">
                        <StageCell stage={p.package} />
                      </td>
                      <td className="py-3 px-4 text-center">
                        <StageCell stage={p.deploy} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={pipelines.page} totalPages={pipelines.totalPages} onPageChange={handlePipelinesPageChange} />
          
          <div className="mt-4 text-sm text-[var(--text-muted)] flex items-center gap-4">
            <span>Legend:</span>
            <span className="flex items-center gap-1"><span className="text-[var(--green)]">✅</span> Success</span>
            <span className="flex items-center gap-1"><span className="text-[var(--red)]">❌</span> Failed</span>
            <span className="flex items-center gap-1"><span className="text-yellow-500">⏳</span> Running</span>
            <span className="flex items-center gap-1"><span>⚪</span> Pending</span>
          </div>
        </div>
      )}

      {/* Scheduled Tasks Tab */}
      {activeTab === 'tasks' && (
        <div>
          {tasks.stats && (
            <div className="grid grid-cols-4 gap-4 mb-4">
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
                <div className="text-xs text-[var(--text-muted)]">Total Runs</div>
                <div className="text-xl font-bold">{tasks.stats.total_runs}</div>
              </div>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
                <div className="text-xs text-[var(--text-muted)]">Runs (24h)</div>
                <div className="text-xl font-bold">{tasks.stats.runs_24h}</div>
              </div>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
                <div className="text-xs text-[var(--text-muted)]">Failures (24h)</div>
                <div className={`text-xl font-bold ${tasks.stats.failures_24h > 0 ? 'text-red-400' : ''}`}>{tasks.stats.failures_24h}</div>
              </div>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
                <div className="text-xs text-[var(--text-muted)]">Success Rate</div>
                <div className="text-xl font-bold">
                  {tasks.stats.total_runs > 0 
                    ? Math.round(((tasks.stats.total_runs - tasks.stats.failures_24h) / tasks.stats.total_runs) * 100) 
                    : 0}%
                </div>
              </div>
            </div>
          )}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Task</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">App</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Runs</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">✓ / ✗</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Last Run</th>
                  <th className="text-center py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {tasks.summary.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No scheduled tasks for this repository.</td>
                  </tr>
                ) : (
                  tasks.summary.map((task, i) => (
                    <tr key={i} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4 font-medium">{task.task_name}</td>
                      <td className="py-3 px-4 text-[var(--text-secondary)]">{task.app_name || 'Unknown'}</td>
                      <td className="py-3 px-4 text-center">{task.total_runs}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="text-[var(--green)]">{task.success_count}</span>
                        {' / '}
                        <span className="text-[var(--red)]">{task.failure_count}</span>
                      </td>
                      <td className="py-3 px-4 text-[var(--text-muted)]">
                        {formatRelativeTime(task.last_run)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button 
                          onClick={() => task.last_output && setSelectedOutput(task.last_output)}
                          className="inline-flex items-center gap-1"
                        >
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            task.last_status === 'success' 
                              ? 'bg-green-500/20 text-green-400' 
                              : 'bg-red-500/20 text-red-400'
                          }`}>
                            {task.last_status === 'success' ? '✓' : '✗'}
                          </span>
                          {task.last_output && (
                            <span className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)]">📋</span>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Output Modal */}
      {selectedOutput && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedOutput(null)}>
          <div 
            className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
              <h3 className="font-semibold">Task Output</h3>
              <button onClick={() => setSelectedOutput(null)} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
            </div>
            <div className="p-4 overflow-auto flex-1">
              <pre className="text-sm font-mono whitespace-pre-wrap break-words bg-[var(--bg-secondary)] p-4 rounded-lg">
                {selectedOutput}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Events Tab */}
      {activeTab === 'events' && (
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Event</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Source</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {events.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-[var(--text-muted)]">No events yet.</td>
                  </tr>
                ) : (
                  events.items.map((e, idx) => (
                    <tr key={e.id || idx} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 px-4">
                        <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                          {e.event_type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-[var(--text-secondary)]">
                        {e.action || '-'}
                      </td>
                      <td className="py-3 px-4 text-[var(--text-muted)]">
                        {e.source || 'github'}
                      </td>
                      <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                        {e.created_at ? new Date(e.created_at).toLocaleString() : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={events.page} totalPages={events.totalPages} onPageChange={handleEventsPageChange} />
        </div>
      )}
    </div>
  );
}
