import { App } from '@octokit/app';
import fs from 'fs';
import { upsertRepo, getAllRepos } from './db.ts';

const APP_ID = process.env.GITHUB_APP_ID!;
const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  } else if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8');
  } else {
    return fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH || '/app/private-key.pem', 'utf8');
  }
}

let _githubApp: App | null = null;

function getGithubApp(): App {
  if (!_githubApp) {
    _githubApp = new App({
      appId: APP_ID,
      privateKey: getPrivateKey(),
    });
  }
  return _githubApp;
}

export const githubApp = new Proxy({} as App, {
  get(target, prop) {
    return (getGithubApp() as any)[prop];
  }
});

export async function getInstallationOctokit(installationId: number) {
  return await githubApp.getInstallationOctokit(installationId);
}

export async function syncReposFromInstallations() {
  console.log('🔄 Syncing repositories from GitHub App installations...');
  
  try {
    const allRepos = [];
    
    for await (const { installation } of githubApp.eachInstallation.iterator()) {
      try {
        const octokit = await githubApp.getInstallationOctokit(installation.id);
        const { data } = await octokit.request('GET /installation/repositories', { per_page: 100 });
        
        console.log(`Installation ${installation.id} (${installation.account?.login}): ${data.repositories.length} repos`);
        
        for (const repo of data.repositories) {
          await upsertRepo(repo.full_name, installation.id, false);
          allRepos.push({ full_name: repo.full_name, installation_id: installation.id });
        }
      } catch (err: any) {
        console.error(`Error fetching repos for installation ${installation.id}:`, err.message);
      }
    }
    
    console.log(`✅ Synced ${allRepos.length} repositories`);
    return allRepos;
  } catch (error: any) {
    console.error('Error syncing repos:', error.message);
    return [];
  }
}

export async function fetchPRCheckFiles(octokit: any, owner: string, repo: string, ref: string) {
  const files = [];
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path: '.jean-ci/pr-checks', ref,
    });
    
    if (Array.isArray(data)) {
      for (const file of data) {
        if (file.name.endsWith('.md')) {
          const { data: content } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner, repo, path: file.path, ref,
          });
          files.push({
            name: file.name.replace('.md', ''),
            path: file.path,
            content: Buffer.from(content.content, 'base64').toString('utf8'),
          });
        }
      }
    }
  } catch (e: any) {
    if (e.status !== 404) console.error('Error fetching PR check files:', e.message);
  }
  return files;
}

export async function getPRDiff(octokit: any, owner: string, repo: string, prNumber: number): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return data as unknown as string;
}

export async function getPRInfo(octokit: any, owner: string, repo: string, prNumber: number) {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber,
  });
  return data;
}

export function canCreateOverrideApproval(checkRun: {
  head_sha?: string | null;
  pr_number: number;
}, prInfo: {
  state?: string;
  draft?: boolean;
  head?: { sha?: string | null };
} | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!prInfo) {
    return { ok: false, reason: `PR #${checkRun.pr_number} was not found` };
  }

  if (prInfo.state !== 'open') {
    return { ok: false, reason: `PR #${checkRun.pr_number} is not open` };
  }

  if (prInfo.draft) {
    return { ok: false, reason: `PR #${checkRun.pr_number} is still a draft` };
  }

  const reviewHeadSha = (checkRun.head_sha || '').trim();
  const currentPrHeadSha = (prInfo.head?.sha || '').trim();
  if (reviewHeadSha && currentPrHeadSha && reviewHeadSha !== currentPrHeadSha) {
    return {
      ok: false,
      reason: `PR #${checkRun.pr_number} head changed from ${reviewHeadSha} to ${currentPrHeadSha}`,
    };
  }

  return { ok: true };
}

export async function createPRReview(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
) {
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: prNumber,
    event,
    body,
  });
  return data;
}

export async function createCheck(octokit: any, owner: string, repo: string, name: string, headSha: string, status = 'queued') {
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner, repo, name, head_sha: headSha, status,
  });
  return data;
}

export async function updateCheck(octokit: any, owner: string, repo: string, checkRunId: number, updates: any) {
  const { data } = await octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner, repo, check_run_id: checkRunId, ...updates,
  });
  return data;
}

export async function createGitHubDeployment(octokit: any, owner: string, repo: string, ref: string, environment: string, description: string) {
  try {
    const { data: deployment } = await octokit.request('POST /repos/{owner}/{repo}/deployments', {
      owner, repo, ref,
      environment,
      description,
      auto_merge: false,
      required_contexts: [],
    });
    return deployment;
  } catch (error: any) {
    console.error('Error creating deployment:', error.message);
    return null;
  }
}

export async function updateDeploymentStatus(
  octokit: any, 
  owner: string, 
  repo: string, 
  deploymentId: number, 
  state: string, 
  description: string, 
  logUrl?: string, 
  environmentUrl?: string
) {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses', {
      owner, repo, deployment_id: deploymentId,
      state,
      description,
      log_url: logUrl,
      environment_url: environmentUrl || logUrl,
    });
  } catch (error: any) {
    console.error('Error updating deployment status:', error.message);
  }
}

// OAuth helpers
export const GITHUB_OAUTH = {
  CLIENT_ID,
  CLIENT_SECRET,
};

export async function exchangeCodeForToken(code: string, redirectUri: string) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      client_id: CLIENT_ID, 
      client_secret: CLIENT_SECRET, 
      code,
      redirect_uri: redirectUri,
    }),
  });
  
  return await tokenRes.json();
}

export async function getGitHubUser(accessToken: string) {
  const userRes = await fetch('https://api.github.com/user', {
    headers: { 
      'Authorization': `Bearer ${accessToken}`, 
      'User-Agent': 'jean-ci' 
    },
  });
  
  return await userRes.json();
}
