const COOLIFY_URL = process.env.COOLIFY_URL || 'https://apps.telegraphic.app';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN;

export async function fetchCoolifyConfig(octokit: any, owner: string, repo: string, ref = 'main') {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path: '.jean-ci/coolify.yml', ref,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return parseSimpleYaml(content);
  } catch (e: any) {
    if (e.status !== 404) console.error('Error fetching coolify.yml:', e.message);
    return null;
  }
}

function parseSimpleYaml(content: string) {
  const config: any = { deployments: [] };
  let currentDeployment: any = null;
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    if (trimmed.startsWith('- package:')) {
      if (currentDeployment) config.deployments.push(currentDeployment);
      currentDeployment = { package: trimmed.replace('- package:', '').trim() };
    } else if (currentDeployment && trimmed.includes(':')) {
      const [key, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim() === 'coolify_app') {
        currentDeployment.coolify_app = value;
      } else if (key.trim() === 'environment') {
        currentDeployment.environment = value;
      }
    }
  }
  if (currentDeployment) config.deployments.push(currentDeployment);
  
  return config;
}

export async function getCoolifyAppDetails(appUuid: string) {
  if (!COOLIFY_TOKEN) return null;
  
  try {
    const response = await fetch(`${COOLIFY_URL}/api/v1/applications/${appUuid}`, {
      headers: { 'Authorization': `Bearer ${COOLIFY_TOKEN}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      fqdn: data.fqdn,
      name: data.name,
      status: data.status,
      projectUuid: data.project?.uuid,
      environmentName: data.environment?.name,
    };
  } catch (e: any) {
    console.error('Error fetching Coolify app details:', e.message);
    return null;
  }
}

export async function triggerCoolifyDeploy(appUuid: string) {
  if (!COOLIFY_TOKEN) {
    console.log('[MOCK] Would trigger Coolify deploy for:', appUuid);
    return { success: true, mock: true };
  }

  try {
    const response = await fetch(`${COOLIFY_URL}/api/v1/applications/${appUuid}/restart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COOLIFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }
    
    const data = await response.json();
    return { success: true, deploymentUuid: data.deployment_uuid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export interface PendingDeployment {
  octokit: any;
  owner: string;
  repo: string;
  headSha?: string;
  deploymentId?: number;
  checkRunId?: number;
  logsUrl: string;
  appUrl: string;
  createdAt: number;
}

// Store pending deployments
export const pendingDeployments = new Map<string, PendingDeployment>();

// Auto-cleanup after 10 minutes
export function registerPendingDeployment(appUuid: string, deployment: PendingDeployment) {
  pendingDeployments.set(appUuid, deployment);
  
  setTimeout(() => {
    if (pendingDeployments.has(appUuid)) {
      pendingDeployments.delete(appUuid);
      console.log(`[Cleanup] Removed stale pending deployment for ${appUuid}`);
    }
  }, 10 * 60 * 1000);
}
