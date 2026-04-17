'use client';

import { useEffect, useMemo, useState } from 'react';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ProbeMode = 'sessions_list' | 'chat_send';

type ProbeResult = {
  ok: boolean;
  mode: ProbeMode;
  latencyMs: number;
  result?: unknown;
  error?: string;
  errorDetails?: Record<string, unknown>;
  selectedRole: string;
  selectedScopes: string[];
  recommendedRole: string;
  recommendedScopes: string[];
  sessionKey?: string;
};

type PlaygroundOperation = {
  mode: ProbeMode;
  label: string;
  method: string;
  notes: string;
  sources: string[];
  defaultRole: string;
  defaultScopes: string[];
  requiredScopes: string[];
};

type MethodPrivilege = {
  method: string;
  requiredScope: string;
  leastPrivilegeRole: 'operator';
  leastPrivilegeScopes: string[];
  source: 'openclaw-method-scopes' | 'openclaw-admin-prefix-fallback';
};

const AVAILABLE_SCOPES = ['operator.read', 'operator.write', 'operator.admin'] as const;
const AVAILABLE_ROLES = ['operator'] as const;

export default function GatewayPlaygroundPage() {
  const [prompt, setPrompt] = useState('Reply with exactly OK.');
  const [chatInput, setChatInput] = useState('Say hello and confirm websocket chat works.');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [loadingMode, setLoadingMode] = useState<ProbeMode | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [operations, setOperations] = useState<PlaygroundOperation[]>([]);
  const [methodPrivileges, setMethodPrivileges] = useState<MethodPrivilege[]>([]);
  const [selectedMode, setSelectedMode] = useState<ProbeMode>('chat_send');
  const [selectedRole, setSelectedRole] = useState('operator');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['operator.write']);
  const [chatSessionKey, setChatSessionKey] = useState('');

  useEffect(() => {
    void loadOperations();
  }, []);

  const activeOperation = useMemo(
    () => operations.find((operation) => operation.mode === selectedMode) ?? null,
    [operations, selectedMode],
  );

  useEffect(() => {
    if (!activeOperation) return;
    setSelectedRole(activeOperation.defaultRole);
    setSelectedScopes(activeOperation.defaultScopes);
  }, [activeOperation]);

  async function loadOperations() {
    const response = await fetch('/api/system-status/probe');
    const payload = await response.json();
    const nextOperations = Array.isArray(payload.operations) ? payload.operations as PlaygroundOperation[] : [];
    const nextMethods = Array.isArray(payload.methods) ? payload.methods as MethodPrivilege[] : [];
    setOperations(nextOperations);
    setMethodPrivileges(nextMethods);
  }

  async function runProbe(mode: ProbeMode) {
    setLoadingMode(mode);
    try {
      const response = await fetch('/api/system-status/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, prompt, role: selectedRole, scopes: selectedScopes, sessionKey: chatSessionKey }),
      });
      const payload = await response.json();
      setResult(payload);
    } catch (error) {
      setResult({
        ok: false,
        mode,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        selectedRole,
        selectedScopes,
        recommendedRole: selectedRole,
        recommendedScopes: selectedScopes,
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
        body: JSON.stringify({ mode: 'chat_send', prompt: message, role: selectedRole, scopes: selectedScopes, sessionKey: chatSessionKey }),
      });
      const payload = await response.json() as ProbeResult;
      setResult(payload);
      if (payload.sessionKey) setChatSessionKey(payload.sessionKey);

      const assistantText = payload.ok ? extractAssistantText(payload.result) || 'Message sent, but no assistant text found in session transcript yet.' : payload.error || 'No response returned.';
      setChat([...nextChat, { role: 'assistant', content: assistantText }]);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Unknown error';
      setResult({ ok: false, mode: 'chat_send', latencyMs: 0, error: text, selectedRole, selectedScopes, recommendedRole: selectedRole, recommendedScopes: selectedScopes });
      setChat([...nextChat, { role: 'assistant', content: `Error: ${text}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  function toggleScope(scope: string) {
    setSelectedScopes((current) => current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]);
  }

  function applyRecommendedPrivileges() {
    if (!activeOperation) return;
    setSelectedRole(activeOperation.defaultRole);
    setSelectedScopes(activeOperation.defaultScopes);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gateway Playground</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          Pick a gateway operation, see the recommended privileges, then pair/test with exactly those privileges.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Operation</label>
            <select
              value={selectedMode}
              onChange={(event) => setSelectedMode(event.target.value as ProbeMode)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
            >
              {operations.map((operation) => (
                <option key={operation.mode} value={operation.mode}>{operation.label}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg bg-[var(--bg-secondary)] p-4 text-sm space-y-2">
            <div><span className="font-medium">Method:</span> <span className="font-mono">{activeOperation?.method ?? '...'}</span></div>
            <div><span className="font-medium">Recommended role:</span> <span className="font-mono">{activeOperation?.defaultRole ?? '...'}</span></div>
            <div><span className="font-medium">Recommended scopes:</span> <span className="font-mono">{activeOperation?.defaultScopes.join(', ') || '...'}</span></div>
            <div className="text-[var(--text-secondary)]">{activeOperation?.notes}</div>
            {activeOperation?.sources?.length ? (
              <ul className="list-disc pl-5 text-xs text-[var(--text-secondary)] space-y-1">
                {activeOperation.sources.map((source) => <li key={source}>{source}</li>)}
              </ul>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-2">Role</label>
              <select
                value={selectedRole}
                onChange={(event) => setSelectedRole(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
              >
                {AVAILABLE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Scopes</label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_SCOPES.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => toggleScope(scope)}
                    className={`rounded-full border px-3 py-1 text-xs ${selectedScopes.includes(scope) ? 'bg-[var(--accent)] text-[var(--on-accent)] border-[var(--accent)]' : 'border-[var(--border)]'}`}
                  >
                    {scope}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={applyRecommendedPrivileges}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              Use recommended privileges
            </button>
            <button
              onClick={() => runProbe(selectedMode)}
              disabled={loadingMode !== null}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-50"
            >
              {loadingMode === selectedMode ? `Running ${activeOperation?.label ?? 'probe'}…` : `Run ${activeOperation?.label ?? 'probe'}`}
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Probe prompt</label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-sm"
            />
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

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold">Method → privilege map</h2>
          <span className="text-sm text-[var(--text-secondary)]">{methodPrivileges.length} entries from OpenClaw scope rules</span>
        </div>
        <div className="rounded-lg bg-[var(--bg-secondary)] p-4 max-h-[320px] overflow-y-auto text-xs leading-6">
          {methodPrivileges.length === 0 ? (
            <div className="text-[var(--text-secondary)]">Loading…</div>
          ) : (
            <ul className="space-y-1">
              {methodPrivileges.map((entry) => (
                <li key={entry.method} className="flex flex-wrap gap-x-3">
                  <span className="font-mono">{entry.method}</span>
                  <span className="text-[var(--text-secondary)]">→ {entry.requiredScope}</span>
                  <span className="text-[var(--text-secondary)]">({entry.source === 'openclaw-method-scopes' ? 'direct' : 'fallback'})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold">Simple chat</h2>
          <span className="text-sm text-[var(--text-secondary)]">
            {chatLoading ? 'Waiting for reply…' : 'Uses sessions.create + sessions.send + sessions.get with selected privileges'}
          </span>
        </div>

        <div className="space-y-3 rounded-lg bg-[var(--bg-secondary)] p-4 min-h-[320px] max-h-[480px] overflow-y-auto">
          {chat.length === 0 ? (
            <div className="text-sm text-[var(--text-secondary)]">
              Send a short message to verify the currently selected role/scopes can actually execute <span className="font-mono">sessions.send</span>.
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
          <input
            value={chatSessionKey}
            onChange={(event) => setChatSessionKey(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-mono"
            placeholder={`${process.env.NEXT_PUBLIC_OPENCLAW_AGENT_ID || 'main'}:gateway-playground`}
          />
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
    </div>
  );
}

function extractAssistantText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;

  const data = result as {
    messages?: Array<{
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      message?: { content?: Array<{ type?: string; text?: string }> };
    }>;
  };

  if (!Array.isArray(data.messages)) return null;

  for (let i = data.messages.length - 1; i >= 0; i -= 1) {
    const message = data.messages[i];
    if (message?.role !== 'assistant') continue;

    if (typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => part?.text)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim();
      if (text) return text;
    }

    const nested = message.message?.content;
    if (Array.isArray(nested)) {
      const text = nested
        .map((part) => part?.text)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }

  return null;
}
