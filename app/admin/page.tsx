'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Stats {
  totalRepos: number;
  enabledRepos: number;
  recentEvents: number;
  openPRs: number;
  pendingDeploys: number;
}

interface GatewayStatus {
  status: 'connected' | 'pairing_required' | 'auth_error' | 'unreachable' | 'disabled';
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
  detail: string;
  guidance: string | null;
  usingWebSocket: boolean;
  deviceId: string | null;
  latencyMs: number | null;
  debug: {
    gatewayUrl: string | null;
    identityPath: string | null;
    identityExists: boolean;
    tokenStorePath: string | null;
    tokenStoreExists: boolean;
    hasSharedToken: boolean;
    hasStoredDeviceToken: boolean;
  };
  tokenAdmin: {
    deviceId: string | null;
    requestedRole: string;
    requestedScopes: string[];
    storedRole: string | null;
    storedScopes: string[];
    hasStoredToken: boolean;
    storedTokenUpdatedAtMs: number | null;
  };
}

export default function AdminOverview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [tokenActionBusy, setTokenActionBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/repos').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/system-status').then(r => r.json()),
    ]).then(([repos, events, dashStats, systemStatus]) => {
      setStats({
        totalRepos: repos.length,
        enabledRepos: repos.filter((r: any) => r.pr_review_enabled).length,
        recentEvents: events.length,
        openPRs: dashStats.openPRs,
        pendingDeploys: dashStats.pendingDeploys,
      });
      setGateway(systemStatus.gateway || null);
    });
  }, []);

  async function revokeStoredGatewayToken() {
    setTokenActionBusy(true);
    try {
      const response = await fetch('/api/system-status/token', { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to revoke stored token');
      }
      setGateway((current) => current ? { ...current, tokenAdmin: payload.tokenAdmin, debug: { ...current.debug, hasStoredDeviceToken: payload.tokenAdmin.hasStoredToken, tokenStoreExists: payload.tokenAdmin.hasStoredToken || current.debug.tokenStoreExists } } : current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to revoke stored token');
    } finally {
      setTokenActionBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <Link href="/admin/reviews" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">🔀</div>
          <div className="text-3xl font-bold text-[var(--blue)]">{stats?.openPRs ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Open PRs</div>
        </Link>
        
        <Link href="/admin/deployments" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">🚀</div>
          <div className="text-3xl font-bold text-[var(--yellow)]">{stats?.pendingDeploys ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Pending Deploys</div>
        </Link>
        
        <Link href="/admin/repos" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📦</div>
          <div className="text-3xl font-bold">{stats?.totalRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Repositories</div>
        </Link>
        
        <Link href="/admin/repos?filter=enabled" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">✅</div>
          <div className="text-3xl font-bold text-[var(--green)]">{stats?.enabledRepos ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Reviews Enabled</div>
        </Link>
        
        <Link href="/admin/events" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 hover:shadow-lg transition-shadow">
          <div className="text-3xl mb-2">📋</div>
          <div className="text-3xl font-bold">{stats?.recentEvents ?? '...'}</div>
          <div className="text-sm text-[var(--text-secondary)]">Events</div>
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
          <div className="space-y-2">
            <Link href="/admin/prompt" className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors">
              <span className="text-xl">📝</span>
              <div>
                <div className="font-medium">Edit Review Prompt</div>
                <div className="text-sm text-[var(--text-secondary)]">Customize the LLM review criteria</div>
              </div>
            </Link>
            <Link href="/admin/repos" className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors">
              <span className="text-xl">🔄</span>
              <div>
                <div className="font-medium">Sync Repositories</div>
                <div className="text-sm text-[var(--text-secondary)]">Refresh from GitHub App installations</div>
              </div>
            </Link>
          </div>
        </div>

        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">System Status</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Health</span>
              <span className="flex items-center gap-2 text-[var(--green)]">
                <span className="w-2 h-2 rounded-full bg-current"></span>
                Healthy
              </span>
            </div>
            <div className="flex items-start justify-between gap-4">
              <span className="text-[var(--text-secondary)]">OpenClaw Gateway</span>
              <div className="text-right">
                <span className={`inline-flex items-center gap-2 ${gateway?.color === 'green' ? 'text-[var(--green)]' : gateway?.color === 'yellow' ? 'text-[var(--yellow)]' : gateway?.color === 'gray' ? 'text-[var(--text-secondary)]' : 'text-[var(--red)]'}`}>
                  <span className="w-2 h-2 rounded-full bg-current"></span>
                  {gateway?.label ?? '...'}
                </span>
                <div className="mt-1 text-xs text-[var(--text-secondary)] max-w-sm">
                  {gateway?.detail ?? 'Checking gateway status...'}
                </div>
                {gateway?.deviceId && (
                  <div className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
                    Device: {gateway.deviceId}
                  </div>
                )}
                {gateway?.guidance && (
                  <details className="mt-3 text-xs text-[var(--text-secondary)] max-w-sm whitespace-pre-line rounded-lg border border-[var(--border)] p-3">
                    <summary className="cursor-pointer select-none font-medium text-[var(--text-primary)]">Recovery steps</summary>
                    <div className="mt-2">{gateway.guidance}</div>
                  </details>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Transport</span>
              <span className="text-sm">{gateway ? (gateway.usingWebSocket ? 'WebSocket' : 'HTTP') : '...'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Probe latency</span>
              <span className="font-mono text-sm">{gateway?.latencyMs != null ? `${gateway.latencyMs} ms` : '—'}</span>
            </div>
            <div className="rounded-lg border border-[var(--border)] p-3 space-y-3">
              <div>
                <div className="text-sm font-medium">Gateway token</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  Requested scopes: <span className="font-mono text-[var(--text-primary)]">{gateway?.tokenAdmin.requestedScopes.join(', ') || '—'}</span>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  Stored scopes: <span className="font-mono text-[var(--text-primary)]">{gateway?.tokenAdmin.storedScopes.join(', ') || 'none stored yet'}</span>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  To request a fresh higher-privilege token, revoke the cached device token here and then trigger a new gateway action. The next successful auth handshake will ask the gateway for <span className="font-mono text-[var(--text-primary)]">operator.read, operator.write, operator.admin</span>.
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void revokeStoredGatewayToken()}
                  disabled={tokenActionBusy || !gateway?.tokenAdmin.hasStoredToken}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
                >
                  {tokenActionBusy ? 'Revoking…' : 'Revoke stored token'}
                </button>
                <Link href="/admin/gateway" className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
                  Open gateway playground
                </Link>
              </div>
            </div>
            <details className="rounded-lg border border-[var(--border)] p-3">
              <summary className="cursor-pointer select-none text-sm font-medium">Gateway debug</summary>
              <div className="mt-3 space-y-2 text-xs text-[var(--text-secondary)]">
                <div className="flex items-center justify-between gap-4">
                  <span>Gateway URL</span>
                  <span className="font-mono text-right text-[var(--text-primary)] break-all">{gateway?.debug.gatewayUrl ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Identity path</span>
                  <span className="font-mono text-right text-[var(--text-primary)] break-all">{gateway?.debug.identityPath ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Identity file</span>
                  <span>{gateway ? (gateway.debug.identityExists ? 'Present' : 'Missing') : '...'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Token store path</span>
                  <span className="font-mono text-right text-[var(--text-primary)] break-all">{gateway?.debug.tokenStorePath ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Token store</span>
                  <span>{gateway ? (gateway.debug.tokenStoreExists ? 'Present' : 'Missing') : '...'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Shared token</span>
                  <span>{gateway ? (gateway.debug.hasSharedToken ? 'Present' : 'Missing') : '...'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Stored device token</span>
                  <span>{gateway ? (gateway.debug.hasStoredDeviceToken ? 'Present' : 'Missing') : '...'}</span>
                </div>
              </div>
            </details>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Version</span>
              <span className="font-mono text-sm">0.13.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
