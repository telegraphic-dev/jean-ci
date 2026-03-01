'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Deployment {
  id: number;
  event_type: string;
  repo: string;
  action?: string;
  payload?: any;
  created_at: string;
}

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/deployments')
      .then(r => r.json())
      .then(data => {
        setDeployments(Array.isArray(data) ? data : []);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-[var(--text-muted)]">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">All Deployments</h1>
      
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Time</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Repository</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Type</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Status</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-secondary)]">Details</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {deployments.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No deployments yet.</td>
              </tr>
            ) : (
              deployments.map(d => {
                const payload = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
                
                // Construct proper GitHub web URL
                let deploymentUrl: string | undefined;
                if (payload?.workflow_run?.html_url) {
                  deploymentUrl = payload.workflow_run.html_url;
                } else if (payload?.check_run?.html_url) {
                  deploymentUrl = payload.check_run.html_url;
                } else if (payload?.workflow_run?.check_suite_url) {
                  // Convert API URL to web URL
                  const checkSuiteId = payload.workflow_run.check_suite_id;
                  if (checkSuiteId && d.repo) {
                    deploymentUrl = `https://github.com/${d.repo}/actions/runs/${payload.workflow_run.id}`;
                  }
                }
                
                const status = d.action || payload?.workflow_run?.conclusion || payload?.deployment_status?.state || 'unknown';
                const workflowName = payload?.workflow_run?.name || payload?.workflow?.name || d.event_type;
                
                return (
                  <tr key={d.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                    <td className="py-3 px-4 text-[var(--text-muted)] whitespace-nowrap">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      {d.repo ? (
                        <Link href={`/admin/repos/${d.repo}`} className="text-[var(--accent)] hover:underline">
                          {d.repo}
                        </Link>
                      ) : (
                        <span className="text-[var(--text-muted)]">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-block px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs font-mono">
                        {workflowName}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {status === 'success' || status === 'completed' ? (
                        <span className="text-[var(--green)]">✅ Success</span>
                      ) : status === 'failure' || status === 'error' ? (
                        <span className="text-[var(--red)]">❌ Failed</span>
                      ) : status === 'pending' || status === 'in_progress' || status === 'queued' || status === 'requested' ? (
                        <span className="text-yellow-600">⏳ {status}</span>
                      ) : (
                        <span className="text-[var(--text-secondary)]">{status}</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {deploymentUrl && (
                        <a 
                          href={deploymentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] hover:underline"
                        >
                          View on GitHub →
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
