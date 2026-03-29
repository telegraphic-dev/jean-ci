'use client';

import { useState } from 'react';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

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
  const [chatInput, setChatInput] = useState('Say hello and confirm websocket chat works.');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [loadingMode, setLoadingMode] = useState<ProbeResult['mode'] | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
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

  async function sendChatMessage() {
    const message = chatInput.trim();
    if (!message) return;

    const nextChat = [...chat, { role: 'user' as const, content: message }];
    setChat(nextChat);
    setChatInput('');
    setChatLoading(true);

    try {
      const response = await fetch('/api/system-status/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'responses_create', prompt: message }),
      });
      const payload = await response.json() as ProbeResult;
      setResult(payload);

      const assistantText = extractAssistantText(payload.result) || payload.error || 'No assistant text returned.';
      setChat([...nextChat, { role: 'assistant', content: assistantText }]);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Unknown error';
      setResult({ ok: false, mode: 'responses_create', latencyMs: 0, error: text });
      setChat([...nextChat, { role: 'assistant', content: `Error: ${text}` }]);
    } finally {
      setChatLoading(false);
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

      <div className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold">Simple chat</h2>
            <span className="text-sm text-[var(--text-secondary)]">
              {chatLoading ? 'Waiting for reply…' : 'Uses responses.create'}
            </span>
          </div>

          <div className="space-y-3 rounded-lg bg-[var(--bg-secondary)] p-4 min-h-[320px] max-h-[480px] overflow-y-auto">
            {chat.length === 0 ? (
              <div className="text-sm text-[var(--text-secondary)]">
                Send a short message to prove the websocket path can carry a real assistant reply.
              </div>
            ) : chat.map((message, index) => (
              <div
                key={index}
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${message.role === 'user' ? 'ml-auto bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--bg-card)] border border-[var(--border)]'}`}
              >
                {message.content}
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
              placeholder="Ask something small like: say hello and mention the current transport"
            />
            <div className="flex gap-3">
              <button
                onClick={() => void sendChatMessage()}
                disabled={chatLoading}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-50"
              >
                {chatLoading ? 'Sending…' : 'Send message'}
              </button>
              <button
                onClick={() => setChat([])}
                disabled={chatLoading || chat.length === 0}
                className="rounded-lg border border-[var(--border)] px-4 py-2 disabled:opacity-50"
              >
                Clear chat
              </button>
            </div>
          </div>
        </div>

        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold">Latest result</h2>
            <span className="text-sm text-[var(--text-secondary)]">
              {result ? `${result.ok ? 'OK' : 'Failed'} · ${result.latencyMs} ms` : 'No probe run yet'}
            </span>
          </div>

          <pre className="overflow-x-auto rounded-lg bg-[var(--bg-secondary)] p-4 text-xs leading-6 text-[var(--text-primary)] min-h-[320px]">
            {JSON.stringify(result, null, 2) || 'Run a probe to see output.'}
          </pre>
        </div>
      </div>
    </div>
  );
}

function extractAssistantText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;

  const outputText = (result as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText.trim();
  }

  const output = (result as { output?: any[] }).output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  return null;
}
