'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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

interface TaskEvent {
  id: number;
  event_type: string;
  task_name: string | null;
  task_uuid: string | null;
  app_uuid: string | null;
  app_name: string | null;
  repo: string | null;
  status: 'success' | 'failure';
  output: string | null;
  url: string | null;
  created_at: string;
}

interface TaskStats {
  total_tasks: number;
  total_runs: number;
  runs_24h: number;
  failures_24h: number;
}

type ViewMode = 'summary' | 'events';

function StatsCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className="text-sm text-[var(--text-secondary)]">{label}</div>
      <div className={`text-2xl font-bold ${highlight ? 'text-red-400' : ''}`}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'success' | 'failure' }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
      status === 'success' 
        ? 'bg-green-500/20 text-green-400' 
        : 'bg-red-500/20 text-red-400'
    }`}>
      {status === 'success' ? '✓' : '✗'}
    </span>
  );
}

function TimeAgo({ date }: { date: string }) {
  const [text, setText] = useState('');
  
  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const then = new Date(date).getTime();
      const diff = Math.floor((now - then) / 1000);
      
      if (diff < 60) setText(`${diff}s ago`);
      else if (diff < 3600) setText(`${Math.floor(diff / 60)}m ago`);
      else if (diff < 86400) setText(`${Math.floor(diff / 3600)}h ago`);
      else setText(`${Math.floor(diff / 86400)}d ago`);
    };
    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [date]);
  
  return <span className="text-[var(--text-secondary)] text-sm">{text}</span>;
}

function OutputModal({ output, onClose }: { output: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div 
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h3 className="font-semibold">Task Output</h3>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div className="p-4 overflow-auto flex-1">
          <pre className="text-sm font-mono whitespace-pre-wrap break-words bg-[var(--bg-secondary)] p-4 rounded-lg">
            {output || '(no output)'}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function TasksPage() {
  const [view, setView] = useState<ViewMode>('summary');
  const [summary, setSummary] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [repoFilter, setRepoFilter] = useState<string>('');
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ view });
    if (repoFilter) params.set('repo', repoFilter);
    if (view === 'events') {
      params.set('limit', String(limit));
      params.set('offset', String(offset));
    }
    
    fetch(`/api/tasks?${params}`)
      .then(r => r.json())
      .then(data => {
        if (view === 'summary') {
          setSummary(data.summary || []);
        } else {
          setEvents(data.events || []);
          setTotal(data.total || 0);
        }
        setStats(data.stats || null);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching tasks:', err);
        setLoading(false);
      });
  }, [view, repoFilter, offset]);

  // Get unique repos for filter
  const repos = Array.from(new Set(summary.map(t => t.repo).filter(Boolean))) as string[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Scheduled Tasks</h1>
        <div className="flex items-center gap-2">
          <select
            value={repoFilter}
            onChange={e => { setRepoFilter(e.target.value); setOffset(0); }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Repos</option>
            {repos.map(repo => (
              <option key={repo} value={repo}>{repo}</option>
            ))}
          </select>
          <div className="flex bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
            <button
              onClick={() => { setView('summary'); setOffset(0); }}
              className={`px-3 py-1.5 text-sm ${view === 'summary' ? 'bg-blue-500 text-white' : ''}`}
            >
              Summary
            </button>
            <button
              onClick={() => { setView('events'); setOffset(0); }}
              className={`px-3 py-1.5 text-sm ${view === 'events' ? 'bg-blue-500 text-white' : ''}`}
            >
              Events
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <StatsCard label="Total Tasks" value={stats.total_tasks} />
          <StatsCard label="Total Runs" value={stats.total_runs} />
          <StatsCard label="Runs (24h)" value={stats.runs_24h} />
          <StatsCard label="Failures (24h)" value={stats.failures_24h} highlight={stats.failures_24h > 0} />
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-[var(--text-secondary)]">Loading...</div>
      ) : view === 'summary' ? (
        /* Summary View */
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-secondary)] border-b border-[var(--border)]">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Task</th>
                <th className="text-left px-4 py-3 font-medium">App / Repo</th>
                <th className="text-center px-4 py-3 font-medium">Runs</th>
                <th className="text-center px-4 py-3 font-medium">✓ / ✗</th>
                <th className="text-left px-4 py-3 font-medium">Last Run</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-[var(--text-secondary)]">
                    No task events yet
                  </td>
                </tr>
              ) : summary.map((task, i) => (
                <tr key={i} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)]">
                  <td className="px-4 py-3">
                    <div className="font-medium">{task.task_name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-[var(--text-secondary)]">{task.app_name || 'Unknown'}</div>
                    {task.repo && (
                      <Link href={`/admin/repos/${task.repo}`} className="text-xs text-blue-400 hover:underline">
                        {task.repo}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">{task.total_runs}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-green-400">{task.success_count}</span>
                    {' / '}
                    <span className="text-red-400">{task.failure_count}</span>
                  </td>
                  <td className="px-4 py-3">
                    <TimeAgo date={task.last_run} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button 
                      onClick={() => task.last_output && setSelectedOutput(task.last_output)}
                      className="inline-flex items-center gap-1"
                    >
                      <StatusBadge status={task.last_status} />
                      {task.last_output && (
                        <span className="text-xs text-[var(--text-secondary)] hover:text-blue-400">📋</span>
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Events View */
        <>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-secondary)] border-b border-[var(--border)]">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Task</th>
                  <th className="text-left px-4 py-3 font-medium">App</th>
                  <th className="text-left px-4 py-3 font-medium">Repo</th>
                  <th className="text-center px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-[var(--text-secondary)]">
                      No task events yet
                    </td>
                  </tr>
                ) : events.map(event => (
                  <tr key={event.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)]">
                    <td className="px-4 py-3 font-medium">{event.task_name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{event.app_name || 'Unknown'}</td>
                    <td className="px-4 py-3">
                      {event.repo ? (
                        <Link href={`/admin/repos/${event.repo}`} className="text-blue-400 hover:underline">
                          {event.repo}
                        </Link>
                      ) : (
                        <span className="text-[var(--text-secondary)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button 
                        onClick={() => event.output && setSelectedOutput(event.output)}
                        className="inline-flex items-center gap-1"
                      >
                        <StatusBadge status={event.status} />
                        {event.output && (
                          <span className="text-xs text-[var(--text-secondary)] hover:text-blue-400">📋</span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <TimeAgo date={event.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
              >
                ← Prev
              </button>
              <span className="text-sm text-[var(--text-secondary)]">
                {offset + 1}–{Math.min(offset + limit, total)} of {total}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {/* Output Modal */}
      {selectedOutput && (
        <OutputModal output={selectedOutput} onClose={() => setSelectedOutput(null)} />
      )}
    </div>
  );
}
