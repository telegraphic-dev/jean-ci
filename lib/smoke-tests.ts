import { callOpenClaw } from './llm';
import { getInstallationOctokit, createCheck, updateCheck } from './github';
import { insertCheckRun, updateCheckRun } from './db';
import { APP_BASE_URL } from './config';

const BASE_URL = APP_BASE_URL;

interface SmokeTest {
  name: string;
  prompt: string;
  filename: string;
}

interface PendingDeployment {
  owner: string;
  repo: string;
  head_sha: string;
  installation_id: number;
  app_url: string;
  logs_url: string;
}

/**
 * Fetch smoke tests from .jean-ci/smoke-tests/ directory
 */
async function fetchSmokeTests(
  octokit: any,
  owner: string,
  repo: string,
  ref: string
): Promise<SmokeTest[]> {
  const smokeTests: SmokeTest[] = [];
  
  try {
    const { data: contents } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.jean-ci/smoke-tests',
      ref,
    });
    
    if (!Array.isArray(contents)) {
      return smokeTests;
    }
    
    for (const file of contents) {
      if (file.type === 'file' && file.name.endsWith('.md')) {
        const { data: fileContent } = await octokit.repos.getContent({
          owner,
          repo,
          path: file.path,
          ref,
        });
        
        if ('content' in fileContent) {
          const content = Buffer.from(fileContent.content, 'base64').toString('utf-8');
          const name = file.name.replace('.md', '');
          smokeTests.push({
            name,
            prompt: content,
            filename: file.name,
          });
        }
      }
    }
  } catch (error: any) {
    if (error.status !== 404) {
      console.error(`Error fetching smoke tests: ${error.message}`);
    }
    // 404 means no smoke-tests directory, which is fine
  }
  
  return smokeTests;
}

/**
 * Run smoke tests after successful deployment
 */
export async function runSmokeTests(pending: PendingDeployment): Promise<void> {
  const { owner, repo, head_sha: headSha, installation_id, app_url: appUrl } = pending;
  
  console.log(`🧪 Running smoke tests for ${owner}/${repo}@${headSha.slice(0, 7)}`);
  
  if (!installation_id) {
    console.error('Smoke tests: missing installation_id');
    return;
  }
  
  console.log(`Smoke tests: getting octokit for installation ${installation_id}`);
  
  let octokit: any;
  try {
    octokit = await getInstallationOctokit(installation_id);
    console.log(`Smoke tests: octokit type=${typeof octokit}, hasRest=${!!(octokit as any)?.rest}, hasRepos=${!!(octokit as any)?.repos}`);
  } catch (e: any) {
    console.error(`Smoke tests: failed to get octokit for installation ${installation_id}: ${e.message}`);
    return;
  }
  
  if (!octokit) {
    console.error(`Smoke tests: octokit is undefined for installation ${installation_id}`);
    return;
  }
  
  // Fetch smoke tests from repo - use octokit.rest.repos if available (newer API)
  const reposApi = (octokit as any).rest?.repos || (octokit as any).repos;
  if (!reposApi) {
    console.error(`Smoke tests: octokit has no repos API. Keys: ${Object.keys(octokit).join(', ')}`);
    return;
  }
  
  // Fetch smoke tests from repo
  let smokeTests: SmokeTest[];
  try {
    smokeTests = await fetchSmokeTests({ repos: reposApi }, owner, repo, headSha);
  } catch (e: any) {
    console.error(`Smoke tests: failed to fetch smoke tests: ${e.message}`);
    // Create a failed check to report the error
    try {
      const check = await createCheck(octokit, owner, repo, 'Smoke Tests', headSha, 'completed');
      await updateCheck(octokit, owner, repo, check.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'Failed to load smoke tests',
          summary: `Error: ${e.message}\n\nCheck your \`.jean-ci/smoke-tests/\` directory.`,
        },
      });
    } catch (checkErr: any) {
      console.error(`Smoke tests: failed to report error to GitHub: ${checkErr.message}`);
    }
    return;
  }
  
  if (smokeTests.length === 0) {
    console.log(`No smoke tests found for ${owner}/${repo}`);
    return;
  }
  
  console.log(`Found ${smokeTests.length} smoke test(s): ${smokeTests.map(t => t.name).join(', ')}`);
  
  // Run each smoke test
  for (const test of smokeTests) {
    await runSingleSmokeTest(octokit, owner, repo, headSha, test, appUrl);
  }
}

/**
 * Run a single smoke test and report to GitHub
 */
async function runSingleSmokeTest(
  octokit: any,
  owner: string,
  repo: string,
  headSha: string,
  test: SmokeTest,
  appUrl: string
): Promise<void> {
  const checkName = `jean-ci / smoke-test: ${test.name}`;
  
  // Create pending check
  const check = await createCheck(octokit, owner, repo, checkName, headSha, 'in_progress');
  
  // Store in DB (pr_number 0 indicates a non-PR check)
  const dbId = await insertCheckRun({
    github_check_id: check.id,
    repo: `${owner}/${repo}`,
    pr_number: 0,
    check_name: `smoke-test: ${test.name}`,
    head_sha: headSha,
    prompt: test.prompt,
  });
  
  console.log(`Running smoke test: ${test.name} (db: ${dbId}, check: ${check.id})`);
  
  // Replace variables in the prompt
  const processedPrompt = test.prompt
    .replace(/\{\{APP_URL\}\}/g, appUrl)
    .replace(/\{\{OWNER\}\}/g, owner)
    .replace(/\{\{REPO\}\}/g, repo)
    .replace(/\{\{SHA\}\}/g, headSha);
  
  // Build context for the smoke test
  const context = `
## Deployment Info
- **Repository:** ${owner}/${repo}
- **Commit:** ${headSha}
- **App URL:** ${appUrl}

## Instructions
This is a post-deployment smoke test. The app has been deployed to ${appUrl}.
Run the test against this URL.
`;

  try {
    const result = await callOpenClaw(processedPrompt, context);
    
    // Parse verdict
    let conclusion = 'success';
    let title = '✅ Smoke test passed';
    
    if (!result.success) {
      conclusion = 'failure';
      title = '❌ Smoke test failed';
    } else {
      const response = result.response.toUpperCase();
      if (response.includes('VERDICT: FAIL') || response.includes('VERDICT:FAIL')) {
        conclusion = 'failure';
        title = '❌ Smoke test failed';
      } else if (response.includes('VERDICT: PASS') || response.includes('VERDICT:PASS')) {
        conclusion = 'success';
        title = '✅ Smoke test passed';
      } else {
        // No explicit verdict, assume pass if no error
        conclusion = 'success';
        title = '✅ Smoke test completed';
      }
    }
    
    const summary = result.success 
      ? result.response.substring(0, 65535) 
      : `Error: ${result.error}`;
    
    // Update GitHub check
    await updateCheck(octokit, owner, repo, check.id, {
      status: 'completed',
      conclusion,
      details_url: `${BASE_URL}/checks/${dbId}`,
      output: {
        title,
        summary,
      },
    });
    
    // Update DB
    await updateCheckRun(dbId, {
      status: 'completed',
      conclusion,
      title,
      summary,
      completed_at: new Date(),
    });
    
    console.log(`Smoke test "${test.name}" completed: ${conclusion}`);
    
  } catch (error: any) {
    console.error(`Smoke test error: ${error.message}`);
    
    await updateCheck(octokit, owner, repo, check.id, {
      status: 'completed',
      conclusion: 'failure',
      details_url: `${BASE_URL}/checks/${dbId}`,
      output: {
        title: '❌ Smoke test error',
        summary: `Error running smoke test: ${error.message}`,
      },
    });
    
    await updateCheckRun(dbId, {
      status: 'completed',
      conclusion: 'failure',
      title: '❌ Smoke test error',
      summary: `Error running smoke test: ${error.message}`,
      completed_at: new Date(),
    });
  }
}
