'use client';

import { useState } from 'react';

type ProbeResult = {
  ok: boolean;
  mode: 'sessions_list' | 'responses_create';
  latencyMs: number;
  result?: unknown;
  error?: string;
  errorDetails?: Record<string, unknown>;
};

export default function GatewayPlaygroundPage() {
  const [prompt, setPrompt] = useState('Reply with exactly OK.');
  const [loadingMode, setLoadingMode] = useState<ProbeResult['mode'] | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);

  async function runProbe(mode: ProbeResult['mode']) {
    setLoadingMode(mode);
    try {
      const response = await fetch('/api/system-status/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, prompt }),
      });
      const payload = await response.json();
      setResult(payload);
    } catch (error) {
      setResult({
        ok: false,
        mode,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoadingMode(null);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gateway Playground</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          Test the OpenClaw websocket path directly from jean-ci. Start with <span className="font-mono">sessions.list</span>,
          then run a tiny <span className="font-mono">responses.create</span> probe.
        </p>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Probe prompt</label>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-sm"
          />
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Keep it tiny. The goal is transport/auth validation, not a full chat UI.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => runProbe('sessions_list')}
            disabled={loadingMode !== null}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-50"
          >
            {loadingMode === 'sessions_list' ? 'Running sessions.list…' : 'Run sessions.list'}
          </button>
          <button
            onClick={() => runProbe('responses_create')}
            disabled={loadingMode !== null}
            className="rounded-lg border border-[var(--border)] px-4 py-2 disabled:opacity-50"
          >
            {loadingMode === 'responses_create' ? 'Running responses.create…' : 'Run responses.create'}
          </button>
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold">Latest result</h2>
          <span className="text-sm text-[var(--text-secondary)]">
            {result ? `${result.ok ? 'OK' : 'Failed'} · ${result.latencyMs} ms` : 'No probe run yet'}
          </span>
        </div>

        <pre className="overflow-x-auto rounded-lg bg-[var(--bg-secondary)] p-4 text-xs leading-6 text-[var(--text-primary)]">
          {JSON.stringify(result, null, 2) || 'Run a probe to see output.'}
        </pre>
      </div>
    </div>
  );
}
