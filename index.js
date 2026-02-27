const express = require('express');
const crypto = require('crypto');
const session = require('express-session');
const { App } = require('@octokit/app');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// Configuration
// =============================================================================

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const APP_ID = process.env.GITHUB_APP_ID;
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_GITHUB_ID = process.env.ADMIN_GITHUB_ID; // Your GitHub user ID

// Private key handling
let PRIVATE_KEY;
if (process.env.GITHUB_APP_PRIVATE_KEY) {
  PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
} else if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
  PRIVATE_KEY = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8');
} else {
  PRIVATE_KEY = fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH || '/app/private-key.pem', 'utf8');
}

// OpenClaw integration
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

// Initialize GitHub App
const githubApp = new App({
  appId: APP_ID,
  privateKey: PRIVATE_KEY,
});

// =============================================================================
// Database Setup
// =============================================================================

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'jean-ci.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    full_name TEXT UNIQUE NOT NULL,
    installation_id INTEGER NOT NULL,
    pr_review_enabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    delivery_id TEXT UNIQUE,
    repo TEXT,
    action TEXT,
    payload TEXT,
    processed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS check_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    check_name TEXT NOT NULL,
    github_check_id INTEGER,
    status TEXT DEFAULT 'queued',
    conclusion TEXT,
    output TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Default global prompt
const DEFAULT_GLOBAL_PROMPT = `You are a code reviewer. Review this PR for:
- Code quality and best practices
- Potential bugs or issues
- Security concerns
- Performance implications

Be constructive and specific. If the code looks good, say so briefly.`;

// Initialize default config
const initConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
initConfig.run('global_prompt', DEFAULT_GLOBAL_PROMPT);

// =============================================================================
// Database Helpers
// =============================================================================

const getConfig = db.prepare('SELECT value FROM config WHERE key = ?');
const setConfig = db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');

const getRepo = db.prepare('SELECT * FROM repos WHERE full_name = ?');
const upsertRepo = db.prepare(`
  INSERT INTO repos (full_name, installation_id, pr_review_enabled, updated_at) 
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(full_name) DO UPDATE SET 
    installation_id = excluded.installation_id,
    updated_at = CURRENT_TIMESTAMP
`);
const setRepoReviewEnabled = db.prepare('UPDATE repos SET pr_review_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE full_name = ?');
const getAllRepos = db.prepare('SELECT * FROM repos ORDER BY full_name');

const insertEvent = db.prepare('INSERT INTO webhook_events (event_type, delivery_id, repo, action, payload) VALUES (?, ?, ?, ?, ?)');
const getRecentEvents = db.prepare('SELECT id, event_type, delivery_id, repo, action, processed, created_at FROM webhook_events ORDER BY created_at DESC LIMIT ?');
const markEventProcessed = db.prepare('UPDATE webhook_events SET processed = 1 WHERE id = ?');

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
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.id !== ADMIN_GITHUB_ID) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// =============================================================================
// Webhook Signature Verification
// =============================================================================

function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// =============================================================================
// GitHub API Helpers
// =============================================================================

async function getInstallationOctokit(installationId) {
  return await githubApp.getInstallationOctokit(installationId);
}

async function fetchPRCheckFiles(octokit, owner, repo, ref) {
  const files = [];
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.jean-ci/pr-checks',
      ref,
    });
    
    if (Array.isArray(data)) {
      for (const file of data) {
        if (file.name.endsWith('.md')) {
          const { data: content } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: file.path,
            ref,
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
    // Directory doesn't exist, that's fine
    if (e.status !== 404) {
      console.error('Error fetching PR check files:', e.message);
    }
  }
  return files;
}

async function getPRDiff(octokit, owner, repo, prNumber) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return data;
}

async function getPRInfo(octokit, owner, repo, prNumber) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return data;
}

// =============================================================================
// OpenClaw Integration
// =============================================================================

async function callOpenClaw(prompt, context = '') {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('[MOCK] Would call OpenClaw:', prompt.substring(0, 100) + '...');
    return { success: true, response: '[Mock] Code looks good!' };
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
      const error = await response.text();
      return { success: false, error };
    }
    
    const data = await response.json();
    return { 
      success: true, 
      response: data.choices?.[0]?.message?.content || 'No response',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =============================================================================
// PR Review Logic
// =============================================================================

async function runPRReview(installationId, owner, repo, prNumber, headSha) {
  const repoFullName = `${owner}/${repo}`;
  const repoConfig = getRepo.get(repoFullName);
  
  if (!repoConfig || !repoConfig.pr_review_enabled) {
    console.log(`PR review disabled for ${repoFullName}`);
    return;
  }

  const octokit = await getInstallationOctokit(installationId);
  
  // Get PR info and diff
  const [prInfo, diff] = await Promise.all([
    getPRInfo(octokit, owner, repo, prNumber),
    getPRDiff(octokit, owner, repo, prNumber),
  ]);

  // Fetch check files from repo
  const checkFiles = await fetchPRCheckFiles(octokit, owner, repo, headSha);
  
  // Get global prompt
  const globalPromptRow = getConfig.get('global_prompt');
  const globalPrompt = globalPromptRow?.value || DEFAULT_GLOBAL_PROMPT;

  // Build checks to run
  const checks = [
    { name: 'Global Standards', prompt: globalPrompt, isGlobal: true },
    ...checkFiles.map(f => ({ name: f.name, prompt: f.content, isGlobal: false })),
  ];

  console.log(`Running ${checks.length} checks for ${repoFullName}#${prNumber}`);

  // Create check runs for each
  for (const check of checks) {
    try {
      // Create check run in "in_progress" state
      const { data: checkRun } = await octokit.rest.checks.create({
        owner,
        repo,
        name: `jean-ci / ${check.name}`,
        head_sha: headSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });

      // Build context for LLM
      const context = `
# Pull Request: ${prInfo.title}

## Description
${prInfo.body || 'No description provided'}

## Changed Files
${diff.substring(0, 50000)} ${diff.length > 50000 ? '\n\n[Diff truncated...]' : ''}
`;

      // Call OpenClaw for review
      const result = await callOpenClaw(check.prompt, context);
      
      // Determine conclusion based on response
      let conclusion = 'success';
      let title = 'Looks good!';
      
      if (!result.success) {
        conclusion = 'failure';
        title = 'Review failed';
      } else if (result.response.toLowerCase().includes('error') || 
                 result.response.toLowerCase().includes('critical') ||
                 result.response.toLowerCase().includes('must fix')) {
        conclusion = 'failure';
        title = 'Issues found';
      } else if (result.response.toLowerCase().includes('warning') ||
                 result.response.toLowerCase().includes('consider') ||
                 result.response.toLowerCase().includes('suggest')) {
        conclusion = 'neutral';
        title = 'Suggestions available';
      }

      // Update check run with results
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRun.id,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title,
          summary: result.success ? result.response.substring(0, 65535) : `Error: ${result.error}`,
        },
      });

      console.log(`Check "${check.name}" completed: ${conclusion}`);
    } catch (error) {
      console.error(`Error running check "${check.name}":`, error.message);
    }
  }
}

// =============================================================================
// Webhook Handlers
// =============================================================================

async function handlePullRequest(payload) {
  const { action, pull_request, repository, installation } = payload;
  const repo = repository.full_name;
  
  // Update repo in database
  upsertRepo.run(repo, installation.id, 0);
  
  if (action === 'opened' || action === 'synchronize') {
    const [owner, repoName] = repo.split('/');
    await runPRReview(installation.id, owner, repoName, pull_request.number, pull_request.head.sha);
  }
}

async function handleInstallation(payload) {
  const { action, installation, repositories } = payload;
  
  if (action === 'created' || action === 'added') {
    const repos = repositories || payload.repositories_added || [];
    for (const repo of repos) {
      upsertRepo.run(repo.full_name, installation.id, 0);
    }
  }
}

async function handleEvent(event, payload) {
  const repo = payload.repository?.full_name || 'unknown';
  
  switch (event) {
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    case 'installation':
    case 'installation_repositories':
      await handleInstallation(payload);
      break;
    case 'check_suite':
      // Could trigger re-run of checks
      break;
    default:
      console.log(`Unhandled event: ${event} on ${repo}`);
  }
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

  // Store event
  try {
    insertEvent.run(event, delivery, payload.repository?.full_name || null, payload.action || null, JSON.stringify(payload));
  } catch (e) {
    // Duplicate delivery, ignore
  }

  res.status(200).json({ received: true });

  // Process asynchronously
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
  
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`,
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
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });
    
    const tokenData = await tokenRes.json();
    
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to get access token');
    }
    
    // Get user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'User-Agent': 'jean-ci',
      },
    });
    
    const user = await userRes.json();
    
    // Check if admin
    if (ADMIN_GITHUB_ID && String(user.id) !== String(ADMIN_GITHUB_ID)) {
      return res.status(403).send('Access denied - not an admin');
    }
    
    req.session.user = {
      id: String(user.id),
      login: user.login,
      avatar: user.avatar_url,
    };
    
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
  if (!req.session.user) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.session.user });
});

app.get('/api/config', requireAdmin, (req, res) => {
  const globalPrompt = getConfig.get('global_prompt')?.value || DEFAULT_GLOBAL_PROMPT;
  res.json({ global_prompt: globalPrompt });
});

app.put('/api/config', requireAdmin, (req, res) => {
  const { global_prompt } = req.body;
  if (global_prompt !== undefined) {
    setConfig.run('global_prompt', global_prompt);
  }
  res.json({ success: true });
});

app.get('/api/repos', requireAdmin, (req, res) => {
  const repos = getAllRepos.all();
  res.json(repos);
});

app.put('/api/repos/:owner/:repo', requireAdmin, (req, res) => {
  const fullName = `${req.params.owner}/${req.params.repo}`;
  const { pr_review_enabled } = req.body;
  
  if (pr_review_enabled !== undefined) {
    setRepoReviewEnabled.run(pr_review_enabled ? 1 : 0, fullName);
  }
  
  res.json({ success: true });
});

app.get('/api/events', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const events = getRecentEvents.all(limit);
  res.json(events);
});

// =============================================================================
// Routes - Admin UI
// =============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'jean-ci', version: '0.2.0' });
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
  <p>GitHub webhook handler for automated PR reviews.</p>
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
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .btn-success { background: #28a745; }
    .btn-danger { background: #dc3545; }
    textarea { width: 100%; height: 200px; font-family: monospace; font-size: 13px; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
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
        <h2>📝 Global PR Review Prompt</h2>
        <p style="color: #666; font-size: 14px;">This prompt is sent to the LLM for every PR review.</p>
        <textarea id="global-prompt"></textarea>
        <br><br>
        <button class="btn btn-success" onclick="savePrompt()">Save Prompt</button>
        <span id="save-status" style="margin-left: 10px; color: #28a745;"></span>
      </div>
      
      <div class="card">
        <h2>📦 Repositories</h2>
        <p style="color: #666; font-size: 14px;">Enable PR reviews per repository. Add custom checks via <code>.jean-ci/pr-checks/*.md</code></p>
        <table>
          <thead>
            <tr><th>Repository</th><th>PR Reviews</th></tr>
          </thead>
          <tbody id="repos-list"></tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>📋 Recent Events</h2>
        <table>
          <thead>
            <tr><th>Time</th><th>Event</th><th>Repository</th><th>Action</th></tr>
          </thead>
          <tbody id="events-list"></tbody>
        </table>
      </div>
    </div>
  </div>
  
  <script>
    let currentUser = null;
    
    async function init() {
      const res = await fetch('/api/me');
      const data = await res.json();
      
      document.getElementById('loading').classList.add('hidden');
      
      if (!data.authenticated) {
        document.getElementById('login-section').classList.remove('hidden');
        return;
      }
      
      currentUser = data.user;
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
      const prompt = document.getElementById('global-prompt').value;
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_prompt: prompt }),
      });
      document.getElementById('save-status').textContent = 'Saved!';
      setTimeout(() => document.getElementById('save-status').textContent = '', 2000);
    }
    
    async function loadRepos() {
      const res = await fetch('/api/repos');
      const repos = await res.json();
      
      const tbody = document.getElementById('repos-list');
      tbody.innerHTML = repos.length === 0 
        ? '<tr><td colspan="2" style="color: #666;">No repositories yet. Install the app on a repo to get started.</td></tr>'
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
      
      const tbody = document.getElementById('events-list');
      tbody.innerHTML = events.length === 0
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
    console.warn('⚠️  Gateway not configured (OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN missing)');
    console.warn('   Running in mock mode - PR reviews will be simulated');
    return false;
  }

  console.log(`🔌 Testing gateway connection: ${OPENCLAW_GATEWAY_URL}`);
  
  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: 'Health check - respond with OK' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      console.log('✅ Gateway connection verified');
      return true;
    } else {
      console.error(`❌ Gateway returned ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Gateway connection failed: ${error.message}`);
    return false;
  }
}

app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`jean-ci v0.2.0 starting...`);
  console.log(`${'='.repeat(50)}\n`);
  
  console.log(`📡 Webhook URL: https://jean-ci.telegraphic.app/webhook`);
  console.log(`🔧 Port: ${PORT}`);
  console.log(`🔑 GitHub App ID: ${APP_ID}`);
  console.log(`👤 Admin GitHub ID: ${ADMIN_GITHUB_ID || '(not set - anyone can access)'}`);
  console.log('');
  
  const gatewayOk = await verifyGatewayConnection();
  
  console.log('');
  console.log(`${'='.repeat(50)}`);
  console.log(`Status: ${gatewayOk ? '🟢 READY' : '🟡 READY (mock mode)'}`);
  console.log(`${'='.repeat(50)}\n`);
});
