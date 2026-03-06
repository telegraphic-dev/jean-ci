'use client';

import { useEffect, useState } from 'react';

interface Task {
  id: number;
  name: string;
  cron_expression: string;
  repo: string | null;
  task_type: string;
  config: Record<string, any>;
  enabled: boolean;
  notify_on_failure: boolean;
  notify_session: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskExecution {
  id: number;
  task_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
  trigger: string;
}

interface TaskWithStats extends Task {
  last_execution?: TaskExecution | null;
  success_count: number;
  failure_count: number;
  avg_duration_ms: number | null;
}

interface Stats {
  total: number;
  enabled: number;
  global: number;
  repo_bound: number;
  last_24h_runs: number;
  last_24h_failures: number;
  active_jobs: number;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskWithStats[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<TaskWithStats | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [runningTask, setRunningTask] = useState<number | null>(null);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks?stats=true');
      const data = await res.json();
      setTasks(data.tasks || []);
      setStats(data.stats || null);
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const handleToggleEnabled = async (task: TaskWithStats) => {
    await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !task.enabled }),
    });
    fetchTasks();
  };

  const handleRunNow = async (taskId: number) => {
    setRunningTask(taskId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/run`, { method: 'POST' });
      const data = await res.json();
      alert(data.message || 'Task executed');
      fetchTasks();
    } catch (e: any) {
      alert('Failed to run task: ' + e.message);
    } finally {
      setRunningTask(null);
    }
  };

  const handleDelete = async (taskId: number) => {
    if (!confirm('Delete this task?')) return;
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    fetchTasks();
  };

  const formatDuration = (ms: number | null) => {
    if (ms === null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (date: string | null) => {
    if (!date) return '-';
    return new Date(date).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      success: 'bg-green-500/20 text-green-400',
      failure: 'bg-red-500/20 text-red-400',
      running: 'bg-blue-500/20 text-blue-400',
      pending: 'bg-yellow-500/20 text-yellow-400',
      timeout: 'bg-orange-500/20 text-orange-400',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400';
  };

  const getTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      health_check: 'bg-cyan-500/20 text-cyan-400',
      webhook: 'bg-purple-500/20 text-purple-400',
      llm_check: 'bg-pink-500/20 text-pink-400',
      command: 'bg-orange-500/20 text-orange-400',
    };
    return colors[type] || 'bg-gray-500/20 text-gray-400';
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Scheduled Tasks</h1>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-4 py-2 bg-[var(--blue)] text-white rounded-lg hover:opacity-90"
        >
          + New Task
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-sm text-[var(--text-secondary)]">Total Tasks</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold text-[var(--green)]">{stats.enabled}</div>
            <div className="text-sm text-[var(--text-secondary)]">Enabled</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.global}</div>
            <div className="text-sm text-[var(--text-secondary)]">Global</div>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
            <div className="text-2xl font-bold">{stats.repo_bound}</div>
            <div className="text-sm text-[var(--text-secondary)]">Repo-bound</div>
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

      {/* Tasks Table */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-[var(--bg-secondary)]">
            <tr>
              <th className="text-left p-4 font-medium">Task</th>
              <th className="text-left p-4 font-medium">Type</th>
              <th className="text-left p-4 font-medium">Schedule</th>
              <th className="text-left p-4 font-medium">Last Run</th>
              <th className="text-left p-4 font-medium">Stats</th>
              <th className="text-left p-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-[var(--text-secondary)]">
                  No tasks configured. Create one to get started.
                </td>
              </tr>
            ) : (
              tasks.map((task) => (
                <tr key={task.id} className="border-t border-[var(--border)] hover:bg-[var(--bg-secondary)]">
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleToggleEnabled(task)}
                        className={`w-3 h-3 rounded-full ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`}
                        title={task.enabled ? 'Enabled (click to disable)' : 'Disabled (click to enable)'}
                      />
                      <div>
                        <div className="font-medium">{task.name}</div>
                        {task.repo && (
                          <div className="text-sm text-[var(--text-secondary)]">{task.repo}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs ${getTypeBadge(task.task_type)}`}>
                      {task.task_type.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="p-4">
                    <code className="text-sm bg-[var(--bg-secondary)] px-2 py-1 rounded">
                      {task.cron_expression}
                    </code>
                  </td>
                  <td className="p-4">
                    {task.last_execution ? (
                      <div>
                        <span className={`px-2 py-1 rounded text-xs ${getStatusBadge(task.last_execution.status)}`}>
                          {task.last_execution.status}
                        </span>
                        <div className="text-xs text-[var(--text-secondary)] mt-1">
                          {formatDate(task.last_execution.started_at)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[var(--text-secondary)]">Never</span>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="text-sm">
                      <span className="text-green-400">{task.success_count}✓</span>
                      {' / '}
                      <span className="text-red-400">{task.failure_count}✗</span>
                    </div>
                    {task.avg_duration_ms && (
                      <div className="text-xs text-[var(--text-secondary)]">
                        avg: {formatDuration(task.avg_duration_ms)}
                      </div>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRunNow(task.id)}
                        disabled={runningTask === task.id}
                        className="px-3 py-1 text-sm bg-[var(--blue)] text-white rounded hover:opacity-90 disabled:opacity-50"
                      >
                        {runningTask === task.id ? '...' : 'Run'}
                      </button>
                      <button
                        onClick={() => setSelectedTask(task)}
                        className="px-3 py-1 text-sm border border-[var(--border)] rounded hover:bg-[var(--bg-secondary)]"
                      >
                        View
                      </button>
                      <button
                        onClick={() => handleDelete(task.id)}
                        className="px-3 py-1 text-sm text-red-400 border border-red-400/30 rounded hover:bg-red-500/20"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal 
          task={selectedTask} 
          onClose={() => setSelectedTask(null)} 
        />
      )}

      {/* Create Task Modal */}
      {showCreateForm && (
        <CreateTaskModal 
          onClose={() => setShowCreateForm(false)} 
          onCreated={fetchTasks}
        />
      )}
    </div>
  );
}

function TaskDetailModal({ task, onClose }: { task: TaskWithStats; onClose: () => void }) {
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/tasks/${task.id}/executions?limit=20`)
      .then(r => r.json())
      .then(data => {
        setExecutions(data.executions || []);
        setLoading(false);
      });
  }, [task.id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-bold">{task.name}</h2>
          <button onClick={onClose} className="text-2xl">×</button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <div>
            <div className="text-sm text-[var(--text-secondary)]">Type</div>
            <div>{task.task_type}</div>
          </div>
          <div>
            <div className="text-sm text-[var(--text-secondary)]">Schedule</div>
            <code>{task.cron_expression}</code>
          </div>
          <div>
            <div className="text-sm text-[var(--text-secondary)]">Repository</div>
            <div>{task.repo || 'Global'}</div>
          </div>
          <div>
            <div className="text-sm text-[var(--text-secondary)]">Notifications</div>
            <div>{task.notify_on_failure ? `To: ${task.notify_session || 'Not set'}` : 'Disabled'}</div>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-sm text-[var(--text-secondary)] mb-2">Config</div>
          <pre className="bg-[var(--bg-secondary)] p-4 rounded-lg text-sm overflow-x-auto">
            {JSON.stringify(task.config, null, 2)}
          </pre>
        </div>

        <h3 className="font-semibold mb-2">Execution History</h3>
        {loading ? (
          <div>Loading...</div>
        ) : executions.length === 0 ? (
          <div className="text-[var(--text-secondary)]">No executions yet</div>
        ) : (
          <div className="space-y-2">
            {executions.map(exec => (
              <div key={exec.id} className="bg-[var(--bg-secondary)] p-3 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <span className={`px-2 py-1 rounded text-xs ${exec.status === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                    {exec.status}
                  </span>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {new Date(exec.started_at).toLocaleString()} ({exec.trigger})
                  </span>
                </div>
                {exec.output && (
                  <pre className="text-xs bg-black/30 p-2 rounded mt-2 overflow-x-auto max-h-32">
                    {exec.output}
                  </pre>
                )}
                {exec.error && (
                  <pre className="text-xs text-red-400 bg-red-500/10 p-2 rounded mt-2">
                    {exec.error}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [formData, setFormData] = useState({
    name: '',
    cron_expression: '0 * * * *',
    repo: '',
    task_type: 'health_check',
    config_url: '',
    config_method: 'GET',
    config_expected_status: 200,
    notify_on_failure: true,
    notify_session: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const config: Record<string, any> = {
      url: formData.config_url,
      method: formData.config_method,
      expected_status: formData.config_expected_status,
    };

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          cron_expression: formData.cron_expression,
          repo: formData.repo || null,
          task_type: formData.task_type,
          config,
          notify_on_failure: formData.notify_on_failure,
          notify_session: formData.notify_session || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create task');
      }

      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 max-w-lg w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-bold">Create Task</h2>
          <button onClick={onClose} className="text-2xl">×</button>
        </div>

        {error && (
          <div className="bg-red-500/20 text-red-400 p-3 rounded-lg mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
              required
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Cron Expression</label>
            <input
              type="text"
              value={formData.cron_expression}
              onChange={e => setFormData({ ...formData, cron_expression: e.target.value })}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg font-mono"
              placeholder="0 * * * *"
              required
            />
            <div className="text-xs text-[var(--text-secondary)] mt-1">
              e.g., &quot;0 9 * * *&quot; = daily at 9am, &quot;*/5 * * * *&quot; = every 5 mins
            </div>
          </div>

          <div>
            <label className="block text-sm mb-1">Repository (optional, for repo-bound tasks)</label>
            <input
              type="text"
              value={formData.repo}
              onChange={e => setFormData({ ...formData, repo: e.target.value })}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
              placeholder="owner/repo"
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Type</label>
            <select
              value={formData.task_type}
              onChange={e => setFormData({ ...formData, task_type: e.target.value })}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
            >
              <option value="health_check">Health Check</option>
              <option value="webhook">Webhook</option>
              <option value="llm_check">LLM Check</option>
            </select>
          </div>

          <div>
            <label className="block text-sm mb-1">URL</label>
            <input
              type="url"
              value={formData.config_url}
              onChange={e => setFormData({ ...formData, config_url: e.target.value })}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
              placeholder="https://example.com/api/health"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">Method</label>
              <select
                value={formData.config_method}
                onChange={e => setFormData({ ...formData, config_method: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Expected Status</label>
              <input
                type="number"
                value={formData.config_expected_status}
                onChange={e => setFormData({ ...formData, config_expected_status: parseInt(e.target.value) })}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="notify"
              checked={formData.notify_on_failure}
              onChange={e => setFormData({ ...formData, notify_on_failure: e.target.checked })}
            />
            <label htmlFor="notify">Notify on failure</label>
          </div>

          {formData.notify_on_failure && (
            <div>
              <label className="block text-sm mb-1">Notify Session Key</label>
              <input
                type="text"
                value={formData.notify_session}
                onChange={e => setFormData({ ...formData, notify_session: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg"
                placeholder="discord:123456..."
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-[var(--border)] rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-[var(--blue)] text-white rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
