'use client';

import { useEffect, useState } from 'react';

interface TaskEvent {
  id: number;
  event_type: string;
  task_name: string;
  app_uuid: string | null;
  repo: string | null;
  status: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  cron_expression: string | null;
  container: string | null;
  created_at: string;
}

interface TaskSummary {
  task_name: string;
  app_uuid: string | null;
  last_status: string;
  last_run: string;
  success_count: number;
  failure_count: number;
}

interface Stats {
  total_executions: number;
  success_count: number;
  failure_count: number;
  last_24h_runs: number;
  last_24h_failures: number;
  unique_tasks: number;
  unique_apps: number;
}

export default function TasksPage() {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [summary, setSummary] = useState<TaskSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<TaskEvent | null>(null);
  const [view, setView] = useState<'summary' | 'events'>('summary');

  useEffect(() => {
    Promise.all([
      fetch('/api/task-events?stats=true&limit=100').then(r => r.json()),
      fetch('/api/task-events/summary').then(r => r.json()).catch(() => ({ summary: [] })),
    ]).then(([eventsData, summaryData]) => {
      setEvents(eventsData.events || []);
      setStats(eventsData.stats || null);
      setSummary(summaryData.summary || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const formatDuration = (ms: number | null) => {
    if (ms === null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      success: 'bg-green-500/20 text-green-400',
      failure: 'bg-red-500/20 text-red-400',
      started: 'bg-blue-500/20 text-blue-400',
      timeout: 'bg-orange-500/20 text-orange-400',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400';
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Scheduled Tasks</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setView('summary')}
            className={`px-4 py-2 rounded-lg ${view === 'summary' ? 'bg-[var(--accent)] text-white' : 'border border-[var(--border)]'}`}
          >
            Summary
          </button>
          <button
            onClick={() => setView('events')}
            className={`px-4 py-2 rounded-lg ${view === 'events' ? 'bg-[var(--accent)] text-white' : 'border border-[var(--border)]'}`}
          >
            All Events
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.unique_tasks}</div>
            <div className="text-sm text-[var(--text-secondary)]">Tasks</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.total_executions}</div>
            <div className="text-sm text-[var(--text-secondary)]">Total Runs</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.last_24h_runs}</div>
            <div className="text-sm text-[var(--text-secondary)]">Runs (24h)</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold text-[var(--red)]">{stats.last_24h_failures}</div>
            <div className="text-sm text-[var(--text-secondary)]">Failures (24h)</div>
          </div>
        </div>
      )}

      {/* Setup Instructions */}
      {events.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">📋 Setup Instructions</h2>
          <p className="text-[var(--text-secondary)] mb-4">
            Tasks are defined and run in Coolify. To monitor them here, add a webhook call to your task commands:
          </p>
          <pre className="bg-black/30 p-4 rounded-lg text-sm overflow-x-auto mb-4">{`# In Coolify scheduled task command:
my-command && curl -sf -X POST https://jean-ci.telegraphic.app/api/webhook/task \\
  -H 'Content-Type: application/json' \\
  -d '{"task":"backup","app":"my-app","status":"success"}'

# Or capture output and status:
output=$(my-command 2>&1) && status="success" || status="failure"; \\
curl -sf -X POST https://jean-ci.telegraphic.app/api/webhook/task \\
  -H 'Content-Type: application/json' \\
  -d "{\\"task\\":\\"backup\\",\\"app\\":\\"my-app\\",\\"status\\":\\"$status\\",\\"output\\":\\"$output\\"}"`}</pre>
          <p className="text-sm text-[var(--text-secondary)]">
            Tasks will appear here once they report their first execution.
          </p>
        </div>
      )}

      {/* Summary View */}
      {view === 'summary' && summary.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-[var(--bg-secondary)]">
              <tr>
                <th className="text-left p-4 font-medium">Task</th>
                <th className="text-left p-4 font-medium">App</th>
                <th className="text-left p-4 font-medium">Last Run</th>
                <th className="text-left p-4 font-medium">Stats</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((task, idx) => (
                <tr key={idx} className="border-t border-[var(--border)] hover:bg-[var(--bg-secondary)]">
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${task.last_status === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="font-medium">{task.task_name}</span>
                    </div>
                  </td>
                  <td className="p-4 text-[var(--text-secondary)]">
                    {task.app_uuid || '-'}
                  </td>
                  <td className="p-4">
                    <div>
                      <span className={`px-2 py-1 rounded text-xs ${getStatusBadge(task.last_status)}`}>
                        {task.last_status}
                      </span>
                      <div className="text-xs text-[var(--text-secondary)] mt-1">
                        {formatDate(task.last_run)}
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="text-green-400">{task.success_count}✓</span>
                    {' / '}
                    <span className="text-red-400">{task.failure_count}✗</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Events View */}
      {view === 'events' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-[var(--bg-secondary)]">
              <tr>
                <th className="text-left p-4 font-medium">Task</th>
                <th className="text-left p-4 font-medium">App</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-left p-4 font-medium">Duration</th>
                <th className="text-left p-4 font-medium">Time</th>
                <th className="text-left p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[var(--text-secondary)]">
                    No task events yet. Configure your Coolify tasks to report here.
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <tr key={event.id} className="border-t border-[var(--border)] hover:bg-[var(--bg-secondary)]">
                    <td className="p-4 font-medium">{event.task_name}</td>
                    <td className="p-4 text-[var(--text-secondary)]">{event.app_uuid || event.repo || '-'}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs ${getStatusBadge(event.status)}`}>
                        {event.status}
                      </span>
                    </td>
                    <td className="p-4">{formatDuration(event.duration_ms)}</td>
                    <td className="p-4 text-sm text-[var(--text-secondary)]">{formatDate(event.created_at)}</td>
                    <td className="p-4">
                      <button
                        onClick={() => setSelectedEvent(event)}
                        className="px-3 py-1 text-sm border border-[var(--border)] rounded hover:bg-[var(--bg-secondary)]"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Event Detail Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedEvent(null)}>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold">{selectedEvent.task_name}</h2>
              <button onClick={() => setSelectedEvent(null)} className="text-2xl">×</button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <div className="text-sm text-[var(--text-secondary)]">Status</div>
                <span className={`px-2 py-1 rounded text-xs ${getStatusBadge(selectedEvent.status)}`}>
                  {selectedEvent.status}
                </span>
              </div>
              <div>
                <div className="text-sm text-[var(--text-secondary)]">Duration</div>
                <div>{formatDuration(selectedEvent.duration_ms)}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--text-secondary)]">App</div>
                <div>{selectedEvent.app_uuid || '-'}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--text-secondary)]">Container</div>
                <div>{selectedEvent.container || '-'}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--text-secondary)]">Time</div>
                <div>{formatDate(selectedEvent.created_at)}</div>
              </div>
              {selectedEvent.cron_expression && (
                <div>
                  <div className="text-sm text-[var(--text-secondary)]">Cron</div>
                  <code>{selectedEvent.cron_expression}</code>
                </div>
              )}
            </div>

            {selectedEvent.output && (
              <div className="mb-4">
                <div className="text-sm text-[var(--text-secondary)] mb-2">Output</div>
                <pre className="bg-black/30 p-4 rounded-lg text-sm overflow-x-auto max-h-48">
                  {selectedEvent.output}
                </pre>
              </div>
            )}

            {selectedEvent.error && (
              <div>
                <div className="text-sm text-[var(--text-secondary)] mb-2">Error</div>
                <pre className="text-red-400 bg-red-500/10 p-4 rounded-lg text-sm overflow-x-auto">
                  {selectedEvent.error}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
