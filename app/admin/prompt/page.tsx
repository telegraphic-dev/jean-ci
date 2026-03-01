'use client';

import { useEffect, useState } from 'react';

export default function PromptPage() {
  const [userPrompt, setUserPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(data => {
      setUserPrompt(data.user_prompt || '');
      setLoading(false);
    });
  }, []);

  async function savePrompt() {
    setSaveStatus('saving');
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_prompt: userPrompt }),
    });
    if (res.ok) {
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(''), 2000);
    } else {
      setSaveStatus('error');
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Review Prompt</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Customize the criteria used for PR reviews. This is appended to the system prompt.
          </p>
        </div>
        <button
          onClick={savePrompt}
          disabled={saveStatus === 'saving'}
          className="bg-[var(--accent)] text-[var(--on-accent)] px-6 py-2 rounded-lg font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
        >
          {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? '✓ Saved' : 'Save Changes'}
        </button>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
        <label className="block text-sm font-medium mb-2">Review Criteria</label>
        <textarea
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          className="w-full h-96 p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
          placeholder="Enter custom review criteria here..."
        />
        <p className="text-sm text-[var(--text-muted)] mt-2">
          Tip: Use markdown formatting. The LLM will use these criteria when reviewing PRs.
        </p>
      </div>
    </div>
  );
}
