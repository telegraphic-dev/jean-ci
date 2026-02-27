import express from 'express';
import crypto from 'crypto';
import session from 'express-session';
import { App } from '@octokit/app';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// =============================================================================
// Configuration
// =============================================================================

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const APP_ID = process.env.GITHUB_APP_ID;
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_GITHUB_ID = process.env.ADMIN_GITHUB_ID;
const DATABASE_URL = process.env.DATABASE_URL;

let PRIVATE_KEY;
if (process.env.GITHUB_APP_PRIVATE_KEY) {
  PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
} else if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
  PRIVATE_KEY = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8');
} else {
  PRIVATE_KEY = fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH || '/app/private-key.pem', 'utf8');
}

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

const githubApp = new App({
  appId: APP_ID,
  privateKey: PRIVATE_KEY,
});

// =============================================================================
// Database Setup
// =============================================================================

const pool = new Pool({ connectionString: DATABASE_URL });

const DEFAULT_GLOBAL_PROMPT = `You are a strict code reviewer acting as an automated CI check.

Review this PR and give a clear PASS or FAIL verdict.

## Criteria for PASS:
- Code follows reasonable quality standards
- No obvious bugs or security issues
- Changes are coherent and purposeful

## Criteria for FAIL:
- Security vulnerabilities (SQL injection, XSS, exposed secrets)
- Obvious bugs that would cause runtime errors
- Breaking changes without migration path
- Code that clearly doesn't work

## Response Format:
Start your response with either:
- **VERDICT: PASS** - if the code meets quality standards
- **VERDICT: FAIL** - if there are blocking issues

Then provide a brief explanation (2-3 sentences max).

Be pragmatic, not pedantic. Style preferences and minor suggestions are NOT reasons to fail.`;

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jean_ci_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_repos (
        id SERIAL PRIMARY KEY,
        full_name TEXT UNIQUE NOT NULL,
        installation_id INTEGER NOT NULL,
        pr_review_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_webhook_events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        delivery_id TEXT UNIQUE,
        repo TEXT,
        action TEXT,
        payload JSONB,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_check_runs (
        id SERIAL PRIMARY KEY,
        github_check_id BIGINT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        check_name TEXT NOT NULL,
        head_sha TEXT,
        status TEXT DEFAULT 'queued',
        conclusion TEXT,
        title TEXT,
        summary TEXT,
        prompt TEXT,
        pr_title TEXT,
        pr_body TEXT,
        diff_preview TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);

    await client.query(`
      INSERT INTO jean_ci_config (key, value) 
      VALUES ('global_prompt', $1) 
      ON CONFLICT (key) DO NOTHING
    `, [DEFAULT_GLOBAL_PROMPT]);

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// =============================================================================
// Database Helpers
// =============================================================================

async function getConfig(key) {
  const result = await pool.query('SELECT value FROM jean_ci_config WHERE key = $1', [key]);
  return result.rows[0]?.value;
}

async function setConfig(key, value) {
  await pool.query(`
    INSERT INTO jean_ci_config (key, value, updated_at) 
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
  `, [key, value]);
}

async function getRepo(fullName) {
  const result = await pool.query('SELECT * FROM jean_ci_repos WHERE full_name = $1', [fullName]);
  return result.rows[0];
}

async function upsertRepo(fullName, installationId, prReviewEnabled = false) {
  await pool.query(`
    INSERT INTO jean_ci_repos (full_name, installation_id, pr_review_enabled, updated_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (full_name) DO UPDATE SET 
      installation_id = $2,
      updated_at = CURRENT_TIMESTAMP
  `, [fullName, installationId, prReviewEnabled]);
}

async function setRepoReviewEnabled(fullName, enabled) {
  await pool.query(`
    UPDATE jean_ci_repos SET pr_review_enabled = $1, updated_at = CURRENT_TIMESTAMP 
    WHERE full_name = $2
  `, [enabled, fullName]);
}

async function getAllRepos() {
  const result = await pool.query('SELECT * FROM jean_ci_repos ORDER BY full_name');
  return result.rows;
}

async function insertCheckRun(data) {
  const result = await pool.query(`
    INSERT INTO jean_ci_check_runs 
    (github_check_id, repo, pr_number, check_name, head_sha, status, prompt, pr_title, pr_body, diff_preview)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [data.github_check_id, data.repo, data.pr_number, data.check_name, data.head_sha, 
      'queued', data.prompt, data.pr_title, data.pr_body, data.diff_preview]);
  return result.rows[0].id;
}

async function updateCheckRun(id, data) {
  await pool.query(`
    UPDATE jean_ci_check_runs SET
      status = COALESCE($2, status),
      conclusion = COALESCE($3, conclusion),
      title = COALESCE($4, title),
      summary = COALESCE($5, summary),
      completed_at = COALESCE($6, completed_at)
    WHERE id = $1
  `, [id, data.status, data.conclusion, data.title, data.summary, data.completed_at]);
}

async function getCheckRun(id) {
  const result = await pool.query('SELECT * FROM jean_ci_check_runs WHERE id = $1', [id]);
  return result.rows[0];
}

async function insertEvent(eventType, deliveryId, repo, action, payload) {
  try {
    await pool.query(`
      INSERT INTO jean_ci_webhook_events (event_type, delivery_id, repo, action, payload)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventType, deliveryId, repo, action, JSON.stringify(payload)]);
  } catch (e) {
    // Duplicate delivery
  }
}

async function getRecentEvents(limit = 50) {
  const result = await pool.query(`
    SELECT id, event_type, delivery_id, repo, action, processed, created_at 
    FROM jean_ci_webhook_events 
    ORDER BY created_at DESC 
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// =============================================================================
// GitHub API Helpers
// =============================================================================

async function getInstallationOctokit(installationId) {
  return await githubApp.getInstallationOctokit(installationId);
}

async function syncReposFromInstallations() {
  console.log('🔄 Syncing repositories from GitHub App installations...');
  
  try {
    const allRepos = [];
    
    for await (const { installation } of githubApp.eachInstallation.iterator()) {
      try {
        // Get a fresh octokit for this installation
        const octokit = await githubApp.getInstallationOctokit(installation.id);
        const { data } = await octokit.request('GET /installation/repositories', { per_page: 100 });
        
        console.log(`Installation ${installation.id} (${installation.account?.login}): ${data.repositories.length} repos`);
        
        for (const repo of data.repositories) {
          await upsertRepo(repo.full_name, installation.id, false);
          allRepos.push({ full_name: repo.full_name, installation_id: installation.id });
        }
      } catch (err) {
        console.error(`Error fetching repos for installation ${installation.id}:`, err.message);
      }
    }
    
    console.log(`✅ Synced ${allRepos.length} repositories`);
    return allRepos;
  } catch (error) {
    console.error('Error syncing repos:', error.message);
    return [];
  }
}

async function fetchPRCheckFiles(octokit, owner, repo, ref) {
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
  } catch (e) {
    if (e.status !== 404) console.error('Error fetching PR check files:', e.message);
  }
  return files;
}

async function getPRDiff(octokit, owner, repo, prNumber) {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return data;
}

async function getPRInfo(octokit, owner, repo, prNumber) {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber,
  });
  return data;
}

async function createCheck(octokit, owner, repo, name, headSha, status = 'queued') {
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner, repo, name, head_sha: headSha, status,
  });
  return data;
}

async function updateCheck(octokit, owner, repo, checkRunId, updates) {
  const { data } = await octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner, repo, check_run_id: checkRunId, ...updates,
  });
  return data;
}

// =============================================================================
// OpenClaw Integration
// =============================================================================

async function callOpenClaw(prompt, context = '') {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('[MOCK] Would call OpenClaw');
    return { success: true, response: '**VERDICT: PASS**\n\n[Mock mode] Code looks good!' };
  }

  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'default',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: context },
        ],
      }),
    });
    
    if (!response.ok) {
      return { success: false, error: await response.text() };
    }
    
    const data = await response.json();
    return { success: true, response: data.choices?.[0]?.message?.content || 'No response' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =============================================================================
// PR Review Logic
// =============================================================================

const BASE_URL = process.env.BASE_URL || 'https://jean-ci.telegraphic.app';

async function runPRReview(installationId, owner, repo, prNumber, headSha) {
  const repoFullName = `${owner}/${repo}`;
  const repoConfig = await getRepo(repoFullName);
  
  if (!repoConfig || !repoConfig.pr_review_enabled) {
    console.log(`PR review disabled for ${repoFullName}`);
    return;
  }

  const octokit = await getInstallationOctokit(installationId);
  
  // Get PR info and diff first (we need it for storing)
  const [prInfo, diff] = await Promise.all([
    getPRInfo(octokit, owner, repo, prNumber),
    getPRDiff(octokit, owner, repo, prNumber),
  ]);

  // Fetch check files from repo
  const checkFiles = await fetchPRCheckFiles(octokit, owner, repo, headSha);
  const globalPrompt = await getConfig('global_prompt') || DEFAULT_GLOBAL_PROMPT;

  // Build checks to run
  const checks = [
    { name: 'Code Review', prompt: globalPrompt, isGlobal: true },
    ...checkFiles.map(f => ({ name: f.name, prompt: f.content, isGlobal: false })),
  ];

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  // Create ALL checks as pending first, storing in DB
  const checkRuns = [];
  for (const check of checks) {
    try {
      // Store in our DB first
      const dbId = await insertCheckRun({
        repo: repoFullName,
        pr_number: prNumber,
        check_name: check.name,
        head_sha: headSha,
        prompt: check.prompt,
        pr_title: prInfo.title,
        pr_body: prInfo.body || '',
        diff_preview: diff.substring(0, 10000),
      });

      // Create GitHub check with details URL
      const checkRun = await createCheck(octokit, owner, repo, `jean-ci / ${check.name}`, headSha, 'queued');
      
      // Update DB with GitHub check ID
      await pool.query('UPDATE jean_ci_check_runs SET github_check_id = $1 WHERE id = $2', [checkRun.id, dbId]);
      
      checkRuns.push({ check, checkRun, dbId });
      console.log(`Created pending check: ${check.name} (db: ${dbId})`);
    } catch (error) {
      console.error(`Error creating check "${check.name}":`, error.message);
    }
  }

  // Run each check
  for (const { check, checkRun, dbId } of checkRuns) {
    try {
      // Mark as in_progress
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
      });

      const context = `
# Pull Request: ${prInfo.title}

## Description
${prInfo.body || 'No description provided'}

## Diff
\`\`\`diff
${diff.substring(0, 50000)}${diff.length > 50000 ? '\n... [truncated]' : ''}
\`\`\`
`;

      const result = await callOpenClaw(check.prompt, context);
      
      // Parse verdict from response
      let conclusion = 'success';
      let title = '✅ Approved';
      
      if (!result.success) {
        conclusion = 'failure';
        title = '❌ Review failed';
      } else {
        const response = result.response.toUpperCase();
        if (response.includes('VERDICT: FAIL') || response.includes('VERDICT:FAIL')) {
          conclusion = 'failure';
          title = '❌ Changes requested';
        } else if (response.includes('VERDICT: PASS') || response.includes('VERDICT:PASS')) {
          conclusion = 'success';
          title = '✅ Approved';
        } else {
          // No clear verdict - default to neutral
          conclusion = 'neutral';
          title = '⚠️ Review complete';
        }
      }

      const summary = result.success ? result.response.substring(0, 65535) : `Error: ${result.error}`;

      // Update GitHub check
      await updateCheck(octokit, owner, repo, checkRun.id, {
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        details_url: `${BASE_URL}/checks/${dbId}`,
        output: { title, summary },
      });

      // Store in DB
      await updateCheckRun(dbId, {
        status: 'completed',
        conclusion,
        title,
        summary,
        completed_at: new Date().toISOString(),
      });

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error) {
      console.error(`Error running check "${check.name}":`, error.message);
      
      // Mark as failed on error
      try {
        await updateCheck(octokit, owner, repo, checkRun.id, {
          status: 'completed',
          conclusion: 'failure',
          completed_at: new Date().toISOString(),
          output: {
            title: '❌ Check failed',
            summary: `Error: ${error.message}`,
          },
        });
      } catch (e) {
        console.error('Failed to update check status:', e.message);
      }
    }
  }
}

// =============================================================================
// Webhook Handlers
// =============================================================================

async function handlePullRequest(payload) {
  const { action, pull_request, repository, installation } = payload;
  const repo = repository.full_name;
  
  await upsertRepo(repo, installation.id, false);
  
  if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
    const [owner, repoName] = repo.split('/');
    // Run asynchronously - don't block webhook response
    runPRReview(installation.id, owner, repoName, pull_request.number, pull_request.head.sha)
      .catch(err => console.error('PR review error:', err));
  }
}

async function handleInstallation(payload) {
  const { action, installation, repositories } = payload;
  
  if (action === 'created' || action === 'added') {
    const repos = repositories || payload.repositories_added || [];
    for (const repo of repos) {
      await upsertRepo(repo.full_name, installation.id, false);
    }
  }
}

async function handleEvent(event, payload) {
  switch (event) {
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    case 'installation':
    case 'installation_repositories':
      await handleInstallation(payload);
      break;
    default:
      console.log(`Event: ${event}`);
  }
}

// =============================================================================
// Middleware
// =============================================================================

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true,  // Required for HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.id !== ADMIN_GITHUB_ID) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// =============================================================================
// Routes - Webhooks
// =============================================================================

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];
  const payload = req.body;

  console.log(`[${new Date().toISOString()}] Event: ${event}, Delivery: ${delivery}`);

  await insertEvent(event, delivery, payload.repository?.full_name || null, payload.action || null, payload);
  res.status(200).json({ received: true });

  try {
    await handleEvent(event, payload);
  } catch (error) {
    console.error('Error handling event:', error);
  }
});

// =============================================================================
// Routes - OAuth
// =============================================================================

app.get('/auth/github', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${protocol}://${req.get('host')}/auth/callback`,
    scope: 'read:user',
    state,
  });
  
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (state !== req.session.oauthState) {
    return res.status(400).send('Invalid state');
  }
  
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to get access token');
    }
    
    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': 'jean-ci' },
    });
    
    const user = await userRes.json();
    
    if (ADMIN_GITHUB_ID && String(user.id) !== String(ADMIN_GITHUB_ID)) {
      return res.status(403).send('Access denied - not an admin');
    }
    
    req.session.user = { id: String(user.id), login: user.login, avatar: user.avatar_url };
    res.redirect('/admin');
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// =============================================================================
// Routes - API
// =============================================================================

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

app.get('/api/config', requireAdmin, async (req, res) => {
  const globalPrompt = await getConfig('global_prompt') || DEFAULT_GLOBAL_PROMPT;
  res.json({ global_prompt: globalPrompt });
});

app.put('/api/config', requireAdmin, async (req, res) => {
  const { global_prompt } = req.body;
  if (global_prompt !== undefined) {
    await setConfig('global_prompt', global_prompt);
  }
  res.json({ success: true });
});

app.get('/api/repos', requireAdmin, async (req, res) => {
  const repos = await getAllRepos();
  res.json(repos);
});

app.post('/api/repos/sync', requireAdmin, async (req, res) => {
  await syncReposFromInstallations();
  const repos = await getAllRepos();
  res.json({ success: true, count: repos.length, repos });
});

app.put('/api/repos/:owner/:repo', requireAdmin, async (req, res) => {
  const fullName = `${req.params.owner}/${req.params.repo}`;
  const { pr_review_enabled } = req.body;
  
  if (pr_review_enabled !== undefined) {
    await setRepoReviewEnabled(fullName, pr_review_enabled);
  }
  res.json({ success: true });
});

app.get('/api/events', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const events = await getRecentEvents(limit);
  res.json(events);
});

// =============================================================================
// Routes - Check Details
// =============================================================================

app.get('/checks/:id', async (req, res) => {
  const checkRun = await getCheckRun(req.params.id);
  
  if (!checkRun) {
    return res.status(404).send('Check not found');
  }

  const statusColors = {
    success: '#28a745',
    failure: '#dc3545',
    neutral: '#6c757d',
    queued: '#ffc107',
    in_progress: '#007bff',
  };
  const statusColor = statusColors[checkRun.conclusion] || statusColors[checkRun.status] || '#6c757d';

  res.send(\`
<!DOCTYPE html>
<html>
<head>
  <title>\${checkRun.check_name} - jean-ci</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 900px; margin: 0 auto; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { margin: 0 0 10px 0; font-size: 1.5rem; }
    .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
    .meta a { color: #0066cc; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: 600; color: white; background: \${statusColor}; }
    h2 { font-size: 1.1rem; margin: 20px 0 10px; color: #333; }
    .summary { background: #f8f9fa; padding: 15px; border-radius: 4px; white-space: pre-wrap; font-family: system-ui; line-height: 1.6; }
    .prompt { background: #fff3cd; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 13px; white-space: pre-wrap; max-height: 300px; overflow-y: auto; }
    .diff { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 12px; white-space: pre; overflow-x: auto; max-height: 400px; }
    .diff .add { color: #4ec9b0; }
    .diff .del { color: #f14c4c; }
    .back { display: inline-block; margin-bottom: 15px; color: #0066cc; text-decoration: none; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <a href="javascript:history.back()" class="back">← Back</a>
    
    <div class="card">
      <h1>jean-ci / \${checkRun.check_name}</h1>
      <div class="meta">
        <span class="status">\${checkRun.conclusion || checkRun.status}</span>
        &nbsp;&nbsp;
        <a href="https://github.com/\${checkRun.repo}/pull/\${checkRun.pr_number}" target="_blank">\${checkRun.repo}#\${checkRun.pr_number}</a>
        &nbsp;·&nbsp;
        \${checkRun.pr_title || 'PR'}
        &nbsp;·&nbsp;
        \${new Date(checkRun.created_at).toLocaleString()}
      </div>
      
      <h2>📝 Review Result</h2>
      <div class="summary">\${checkRun.summary || 'No summary available'}</div>
      
      <h2>🎯 Prompt Used</h2>
      <div class="prompt">\${checkRun.prompt || 'Default prompt'}</div>
      
      \${checkRun.diff_preview ? \`
      <h2>📄 Diff Preview</h2>
      <div class="diff">\${checkRun.diff_preview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      \` : ''}
    </div>
  </div>
</body>
</html>
  \`);
});

// =============================================================================
// Routes - Admin UI
// =============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'jean-ci', version: '0.6.0' });
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>jean-ci</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    a { color: #0066cc; }
    .btn { display: inline-block; padding: 10px 20px; background: #333; color: white; text-decoration: none; border-radius: 5px; }
  </style>
</head>
<body>
  <h1>🤖 jean-ci</h1>
  <p>GitHub CI checks powered by LLM code review.</p>
  <p><a href="/admin" class="btn">Admin Dashboard →</a></p>
</body>
</html>
  `);
});

app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>jean-ci Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 900px; margin: 0 auto; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { margin-top: 0; }
    h2 { margin-top: 0; color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px; }
    .login-prompt { text-align: center; padding: 40px; }
    .btn { display: inline-block; padding: 10px 20px; background: #333; color: white; text-decoration: none; border-radius: 5px; border: none; cursor: pointer; font-size: 14px; }
    .btn:hover { background: #444; }
    .btn-success { background: #28a745; }
    .btn-primary { background: #007bff; }
    textarea { width: 100%; height: 300px; font-family: monospace; font-size: 13px; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; }
    .toggle { cursor: pointer; }
    .toggle.on { color: #28a745; }
    .toggle.off { color: #dc3545; }
    .user-info { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .user-info img { width: 40px; height: 40px; border-radius: 50%; }
    .event-type { display: inline-block; padding: 2px 8px; background: #e9ecef; border-radius: 3px; font-size: 12px; }
    .hidden { display: none; }
    #loading { text-align: center; padding: 40px; color: #666; }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .sync-status { font-size: 12px; color: #666; margin-left: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div id="loading">Loading...</div>
    
    <div id="login-section" class="card login-prompt hidden">
      <h1>🤖 jean-ci Admin</h1>
      <p>Sign in with GitHub to manage PR reviews.</p>
      <a href="/auth/github" class="btn">Sign in with GitHub</a>
    </div>
    
    <div id="admin-section" class="hidden">
      <div class="user-info">
        <img id="user-avatar" src="" alt="avatar">
        <div>
          <strong id="user-name"></strong>
          <a href="/auth/logout" style="margin-left: 10px; font-size: 12px;">Logout</a>
        </div>
      </div>
      
      <div class="card">
        <h2>📝 Global Review Prompt</h2>
        <p style="color: #666; font-size: 14px;">This prompt determines how PRs are reviewed. Use <code>VERDICT: PASS</code> or <code>VERDICT: FAIL</code> format.</p>
        <textarea id="global-prompt"></textarea>
        <br><br>
        <button class="btn btn-success" onclick="savePrompt()">Save Prompt</button>
        <span id="save-status" style="margin-left: 10px; color: #28a745;"></span>
      </div>
      
      <div class="card">
        <div class="header-row">
          <h2 style="margin: 0; border: none; padding: 0;">📦 Repositories</h2>
          <div>
            <button class="btn btn-primary" onclick="syncRepos()">🔄 Sync from GitHub</button>
            <span id="sync-status" class="sync-status"></span>
          </div>
        </div>
        <p style="color: #666; font-size: 14px; margin-top: 15px;">Enable PR reviews per repository. Add custom checks via <code>.jean-ci/pr-checks/*.md</code></p>
        <table>
          <thead><tr><th>Repository</th><th>PR Reviews</th></tr></thead>
          <tbody id="repos-list"></tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>📋 Recent Events</h2>
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Repository</th><th>Action</th></tr></thead>
          <tbody id="events-list"></tbody>
        </table>
      </div>
    </div>
  </div>
  
  <script>
    async function init() {
      const res = await fetch('/api/me');
      const data = await res.json();
      
      document.getElementById('loading').classList.add('hidden');
      
      if (!data.authenticated) {
        document.getElementById('login-section').classList.remove('hidden');
        return;
      }
      
      document.getElementById('user-avatar').src = data.user.avatar;
      document.getElementById('user-name').textContent = data.user.login;
      document.getElementById('admin-section').classList.remove('hidden');
      
      loadConfig();
      loadRepos();
      loadEvents();
    }
    
    async function loadConfig() {
      const res = await fetch('/api/config');
      const data = await res.json();
      document.getElementById('global-prompt').value = data.global_prompt;
    }
    
    async function savePrompt() {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_prompt: document.getElementById('global-prompt').value }),
      });
      document.getElementById('save-status').textContent = 'Saved!';
      setTimeout(() => document.getElementById('save-status').textContent = '', 2000);
    }
    
    async function loadRepos() {
      const res = await fetch('/api/repos');
      const repos = await res.json();
      
      document.getElementById('repos-list').innerHTML = repos.length === 0 
        ? '<tr><td colspan="2" style="color: #666;">No repositories yet. Click "Sync from GitHub" to load them.</td></tr>'
        : repos.map(r => \`
          <tr>
            <td><a href="https://github.com/\${r.full_name}" target="_blank">\${r.full_name}</a></td>
            <td>
              <span class="toggle \${r.pr_review_enabled ? 'on' : 'off'}" onclick="toggleRepo('\${r.full_name}', \${!r.pr_review_enabled})">
                \${r.pr_review_enabled ? '✅ Enabled' : '❌ Disabled'}
              </span>
            </td>
          </tr>
        \`).join('');
    }
    
    async function syncRepos() {
      document.getElementById('sync-status').textContent = 'Syncing...';
      const res = await fetch('/api/repos/sync', { method: 'POST' });
      const data = await res.json();
      document.getElementById('sync-status').textContent = \`Synced \${data.count} repos!\`;
      setTimeout(() => document.getElementById('sync-status').textContent = '', 3000);
      loadRepos();
    }
    
    async function toggleRepo(fullName, enabled) {
      const [owner, repo] = fullName.split('/');
      await fetch(\`/api/repos/\${owner}/\${repo}\`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_review_enabled: enabled }),
      });
      loadRepos();
    }
    
    async function loadEvents() {
      const res = await fetch('/api/events?limit=20');
      const events = await res.json();
      
      document.getElementById('events-list').innerHTML = events.length === 0
        ? '<tr><td colspan="4" style="color: #666;">No events yet.</td></tr>'
        : events.map(e => \`
          <tr>
            <td>\${new Date(e.created_at).toLocaleString()}</td>
            <td><span class="event-type">\${e.event_type}</span></td>
            <td>\${e.repo || '-'}</td>
            <td>\${e.action || '-'}</td>
          </tr>
        \`).join('');
    }
    
    init();
  </script>
</body>
</html>
  `);
});

// =============================================================================
// Startup
// =============================================================================

async function verifyGatewayConnection() {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.warn('⚠️  Gateway not configured - running in mock mode');
    return false;
  }

  console.log(`🔌 Testing gateway: ${OPENCLAW_GATEWAY_URL}`);
  
  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: 'Health check - respond OK' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      console.log('✅ Gateway connected');
      return true;
    }
    console.error(`❌ Gateway returned ${response.status}`);
    return false;
  } catch (error) {
    console.error(`❌ Gateway failed: ${error.message}`);
    return false;
  }
}

async function start() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`jean-ci v0.6.0 starting...`);
  console.log(`${'='.repeat(50)}\n`);
  
  await initDatabase();
  
  console.log(`📡 Webhook: https://jean-ci.telegraphic.app/webhook`);
  console.log(`🔧 Port: ${PORT}`);
  console.log(`🔑 App ID: ${APP_ID}`);
  console.log(`👤 Admin: ${ADMIN_GITHUB_ID || '(anyone)'}`);
  console.log(`🗄️  Database: PostgreSQL`);
  console.log('');
  
  const gatewayOk = await verifyGatewayConnection();
  
  // Sync repos on startup
  await syncReposFromInstallations();
  
  console.log('');
  console.log(`${'='.repeat(50)}`);
  console.log(`Status: ${gatewayOk ? '🟢 READY' : '🟡 READY (mock mode)'}`);
  console.log(`${'='.repeat(50)}\n`);
  
  app.listen(PORT);
}

start().catch(console.error);
