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

export function isRetryablePullRequestDiffError(error: any): boolean {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '');

  return status === 429
    || status === 502
    || status === 503
    || status === 504
    || (status >= 500 && status < 600)
    || /diff is temporarily unavailable|heavy server load/i.test(message);
}

type PullRequestDiffRetryOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
  baseRef?: string;
  headRef?: string;
};

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getPRDiff(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  options: PullRequestDiffRetryOptions = {},
): Promise<string> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1500);
  let primaryError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber,
        mediaType: { format: 'diff' },
      });
      return data as unknown as string;
    } catch (error: any) {
      if (!isRetryablePullRequestDiffError(error)) {
        throw error;
      }
      primaryError = error;
      if (attempt >= maxAttempts) break;

      const delay = retryDelayMs * attempt;
      console.warn(
        `GitHub PR diff fetch failed transiently for ${owner}/${repo}#${prNumber}; retrying attempt ${attempt + 1}/${maxAttempts}: ${error.message}`,
      );
      await wait(delay);
    }
  }

  // GitHub occasionally serves a transient 5xx for the pull diff endpoint on
  // very large PRs. The compare endpoint exercises a separate API path.
  if (options.baseRef && options.headRef) {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner,
        repo,
        basehead: `${options.baseRef}...${options.headRef}`,
        mediaType: { format: 'diff' },
      });
      console.warn(`Fetched PR diff through GitHub compare fallback for ${owner}/${repo}#${prNumber}`);
      return data as unknown as string;
    } catch (error: any) {
      console.warn(`GitHub compare diff fallback failed for ${owner}/${repo}#${prNumber}: ${error.message}`);
    }
  }

  // Last-resort GitHub-only fallback. File patches have a 3,000-file API cap
  // and GitHub can omit an individual oversized/binary patch, but this avoids
  // dropping an entire review because the monolithic renderer is under load.
  try {
    const parts: string[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner, repo, pull_number: prNumber, per_page: 100, page,
      });
      const files = Array.isArray(data) ? data : [];
      if (files.length === 0) break;

      for (const file of files) {
        const beforePath = file.status === 'added' ? '/dev/null' : (file.previous_filename || file.filename);
        const afterPath = file.status === 'removed' ? '/dev/null' : file.filename;
        if (typeof file.patch !== 'string' || !file.patch.trim()) {
          throw new Error(`GitHub omitted the patch for ${file.filename}; refusing an incomplete diff fallback.`);
        }
        const patch = file.patch;
        parts.push([
          `diff --git a/${beforePath} b/${afterPath}`,
          `--- ${beforePath === '/dev/null' ? '/dev/null' : `a/${beforePath}`}`,
          `+++ ${afterPath === '/dev/null' ? '/dev/null' : `b/${afterPath}`}`,
          patch,
        ].join('\n'));
      }
      if (files.length < 100) break;
      if (page === 30) {
        throw new Error('GitHub pull-files fallback reached the 3,000-file API cap; refusing an incomplete diff fallback.');
      }
    }
    if (parts.length > 0) {
      console.warn(`Fetched PR file-patch fallback for ${owner}/${repo}#${prNumber}`);
      return parts.join('\n');
    }
  } catch (error: any) {
    console.warn(`GitHub PR file-patch fallback failed for ${owner}/${repo}#${prNumber}: ${error.message}`);
  }

  throw primaryError || new Error(`Failed to fetch PR diff for ${owner}/${repo}#${prNumber}`);
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
  commitId: string,
) {
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitId,
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

export async function getCheck(octokit: any, owner: string, repo: string, checkRunId: number) {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner, repo, check_run_id: checkRunId,
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
  environmentUrl?: string,
  throwOnError = false,
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
    if (throwOnError) throw error;
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
