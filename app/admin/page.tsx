'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface User {
  id: string;
  login: string;
  avatar: string;
}

interface Repo {
  id: number;
  full_name: string;
  installation_id: number;
  pr_review_enabled: boolean;
}

interface Event {
  id: number;
  event_type: string;
  delivery_id?: string;
  repo?: string;
  action?: string;
  created_at: string;
}

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [userPrompt, setUserPrompt] = useState('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [saveStatus, setSaveStatus] = useState('');
  const [syncStatus, setSyncStatus] = useState('');

  useEffect(() => {
    init();
  }, []);

  async function init() {
    const res = await fetch('/api/me');
    const data = await res.json();
    
    setLoading(false);
    
    if (!data.authenticated) {
      setAuthenticated(false);
      return;
    }
    
    setAuthenticated(true);
    setUser(data.user);
    
    loadConfig();
    loadRepos();
    loadEvents();
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    const data = await res.json();
    setUserPrompt(data.user_prompt);
  }

  async function savePrompt() {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_prompt: userPrompt }),
    });
    setSaveStatus('✓ Saved!');
    setTimeout(() => setSaveStatus(''), 2000);
  }

  async function loadRepos() {
    const res = await fetch('/api/repos');
    const data = await res.json();
    setRepos(data);
  }

  async function syncRepos() {
    setSyncStatus('Syncing...');
    const res = await fetch('/api/repos/sync', { method: 'POST' });
    const data = await res.json();
    setSyncStatus(`✓ Synced ${data.count} repos!`);
    setTimeout(() => setSyncStatus(''), 3000);
    loadRepos();
  }

  async function toggleRepo(fullName: string, enabled: boolean) {
    const [owner, repo] = fullName.split('/');
    await fetch(`/api/repos/${owner}/${repo}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_review_enabled: enabled }),
    });
    loadRepos();
  }

  async function loadEvents() {
    const res = await fetch('/api/events?limit=20');
    const data = await res.json();
    setEvents(data);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-8 text-center shadow-lg">
            <h1 className="text-3xl font-bold mb-4">
              <span className="bg-gradient-to-r from-[#b7642b] to-[#9f5522] bg-clip-text text-transparent">jean-ci Admin</span>
            </h1>
            <p className="text-[var(--text-secondary)] mb-6">Sign in with GitHub to manage PR reviews and deployments.</p>
            <a 
              href="/api/auth/github" 
              className="inline-block bg-[var(--accent)] text-[var(--on-accent)] px-8 py-3 rounded-full font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              Sign in with GitHub
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <img src={user?.avatar} alt="avatar" className="w-12 h-12 rounded-full border-2 border-[var(--border)]" />
            <div>
              <div className="font-semibold">{user?.login}</div>
              <a href="/api/auth/logout" className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">Logout</a>
            </div>
          </div>
          <Link href="/" className="text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">← Back to Home</Link>
        </div>
        
        {/* PR Review Prompt Card */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 mb-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📝</span>
            <h2 className="text-xl font-bold">Global Review Prompt</h2>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            This prompt determines how PRs are reviewed. Use <code className="text-xs bg-[var(--bg-secondary)] px-2 py-1 rounded border border-[var(--border)]">VERDICT: PASS</code> or <code className="text-xs bg-[var(--bg-secondary)] px-2 py-1 rounded border border-[var(--border)]">VERDICT: FAIL</code> format.
          </p>
          <textarea 
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            className="w-full h-64 font-mono text-sm p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:border-[var(--accent)]"
          />
          <div className="flex items-center gap-3 mt-4">
            <button 
              onClick={savePrompt}
              className="bg-[var(--green)] text-white px-6 py-2 rounded-full font-medium hover:opacity-90 transition-opacity"
            >
              Save Prompt
            </button>
            {saveStatus && <span className="text-sm text-[var(--green)] font-medium">{saveStatus}</span>}
          </div>
        </div>
        
        {/* Repositories Card */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">📦</span>
              <h2 className="text-xl font-bold">Repositories</h2>
            </div>
            <div className="flex items-center gap-3">
              {syncStatus && <span className="text-sm text-[var(--text-muted)]">{syncStatus}</span>}
              <button 
                onClick={syncRepos}
                className="bg-[var(--accent)] text-[var(--on-accent)] px-4 py-2 rounded-full text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                🔄 Sync from GitHub
              </button>
            </div>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Enable PR reviews per repository. Add custom checks via <code className="text-xs bg-[var(--bg-secondary)] px-2 py-1 rounded border border-[var(--border)]">.jean-ci/pr-checks/*.md</code>
          </p>
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left py-3 pr-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
                  <th className="text-left py-3 text-sm font-semibold text-[var(--text-secondary)]">PR Reviews</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {repos.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="py-8 text-center text-[var(--text-muted)]">
                      No repositories yet. Click "Sync from GitHub" to load them.
                    </td>
                  </tr>
                ) : (
                  repos.map(r => (
                    <tr key={r.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                      <td className="py-3 pr-4">
                        <a href={`https://github.com/${r.full_name}`} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
                          {r.full_name}
                        </a>
                      </td>
                      <td className="py-3">
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
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        
        {/* Recent Events Card */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📋</span>
            <h2 className="text-xl font-bold">Recent Events</h2>
          </div>
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left py-3 pr-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
                  <th className="text-left py-3 pr-4 text-sm font-semibold text-[var(--text-secondary)]">Event</th>
                  <th className="text-left py-3 pr-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
                  <th className="text-left py-3 text-sm font-semibold text-[var(--text-secondary)]">Action</th>
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
                      <td className="py-3 pr-4 text-[var(--text-muted)]">{new Date(e.created_at).toLocaleString()}</td>
                      <td className="py-3 pr-4">
                        <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                          {e.event_type}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[var(--text-secondary)]">{e.repo || '-'}</td>
                      <td className="py-3 text-[var(--text-secondary)]">{e.action || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
