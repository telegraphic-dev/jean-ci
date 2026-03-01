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
                
                // Extract URLs based on event type
                let githubUrl: string | undefined;
                let coolifyUrl: string | undefined;
                
                // For workflow_run events - link to GitHub Actions
                if (payload?.workflow_run?.html_url) {
                  githubUrl = payload.workflow_run.html_url;
                } else if (payload?.workflow_run?.id && d.repo) {
                  githubUrl = `https://github.com/${d.repo}/actions/runs/${payload.workflow_run.id}`;
                }
                
                // For deployment_status events - link to workflow run via deployment
                if (d.event_type === 'deployment_status' && payload?.deployment?.payload?.workflow_run_id && d.repo) {
                  githubUrl = `https://github.com/${d.repo}/actions/runs/${payload.deployment.payload.workflow_run_id}`;
                } else if (d.event_type === 'deployment_status' && payload?.workflow?.id && d.repo) {
                  githubUrl = `https://github.com/${d.repo}/actions/runs/${payload.workflow.id}`;
                }
                
                // For registry_package events
                if (d.event_type === 'registry_package' && payload?.registry_package?.html_url) {
                  githubUrl = payload.registry_package.html_url;
                }
                
                // Coolify deployment URL
                if (d.event_type?.startsWith('coolify_') && payload?.deployment_url) {
                  coolifyUrl = payload.deployment_url;
                } else if (payload?.deployment?.payload?.coolify_url) {
                  coolifyUrl = payload.deployment.payload.coolify_url;
                }
                
                // Determine status
                let status = d.action || payload?.workflow_run?.conclusion || payload?.deployment_status?.state || 'unknown';
                if (d.event_type === 'coolify_deployment_success') status = 'success';
                if (d.event_type === 'coolify_deployment_failed') status = 'failure';
                
                // Determine display name
                let workflowName = payload?.workflow_run?.name || payload?.workflow?.name || 
                                   payload?.deployment?.environment || d.event_type;
                if (d.event_type?.startsWith('coolify_')) {
                  workflowName = payload?.application_name || 'Coolify';
                }
                
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
                      ) : status === 'pending' || status === 'in_progress' || status === 'queued' || status === 'requested' || status === 'created' ? (
                        <span className="text-yellow-600">⏳ {status}</span>
                      ) : (
                        <span className="text-[var(--text-secondary)]">{status}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 flex gap-2">
                      {githubUrl && (
                        <a 
                          href={githubUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] hover:underline"
                        >
                          GitHub →
                        </a>
                      )}
                      {coolifyUrl && (
                        <a 
                          href={coolifyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] hover:underline"
                        >
                          Coolify →
                        </a>
                      )}
                      {!githubUrl && !coolifyUrl && (
                        <span className="text-[var(--text-muted)]">-</span>
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
