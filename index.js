const express = require('express');
const crypto = require('crypto');
const { App } = require('@octokit/app');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Load config
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const APP_ID = process.env.GITHUB_APP_ID;

// Private key can be: direct PEM, base64-encoded, or file path
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

// Middleware
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Verify webhook signature
function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Send message to Jean via chat completions API
async function notifyJean(message, context = {}) {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('[MOCK] Would notify Jean:', message);
    return;
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
          {
            role: 'user',
            content: `[GitHub Event: ${context.type || 'unknown'}]\n\n${message}`
          }
        ]
      }),
    });
    
    if (!response.ok) {
      console.error('Failed to notify Jean:', await response.text());
    } else {
      const result = await response.json();
      console.log(`[NOTIFIED] ${context.type}: ${result.choices?.[0]?.message?.content?.slice(0, 50)}...`);
    }
  } catch (error) {
    console.error('Error notifying Jean:', error.message);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'jean-ci', version: '0.1.0' });
});

// Events are now sent directly via chat completions API

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  // Verify signature
  if (!verifySignature(req)) {
    console.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];
  const payload = req.body;

  console.log(`[${new Date().toISOString()}] Event: ${event}, Delivery: ${delivery}`);

  // Acknowledge immediately
  res.status(200).json({ received: true });

  // Process event asynchronously
  try {
    await handleEvent(event, payload);
  } catch (error) {
    console.error('Error handling event:', error);
  }
});

// Event handlers
async function handleEvent(event, payload) {
  const repo = payload.repository?.full_name || 'unknown';
  
  switch (event) {
    case 'pull_request':
      await handlePullRequest(payload);
      break;
      
    case 'pull_request_review':
      await handlePullRequestReview(payload);
      break;
      
    case 'pull_request_review_comment':
      await handlePullRequestReviewComment(payload);
      break;
      
    case 'issue_comment':
      await handleIssueComment(payload);
      break;
      
    case 'check_suite':
      await handleCheckSuite(payload);
      break;
      
    case 'deployment_status':
      await handleDeploymentStatus(payload);
      break;
      
    case 'push':
      // Usually too noisy, log only
      console.log(`Push to ${repo}: ${payload.ref}`);
      break;
      
    default:
      console.log(`Unhandled event: ${event} on ${repo}`);
  }
}

// PR opened/synchronized
async function handlePullRequest(payload) {
  const { action, pull_request, repository } = payload;
  const repo = repository.full_name;
  const pr = pull_request;
  
  if (action === 'opened' || action === 'synchronize') {
    const message = `🔔 **PR ${action}:** [${repo}#${pr.number}](${pr.html_url})
**Title:** ${pr.title}
**Author:** ${pr.user.login}
**Branch:** ${pr.head.ref} → ${pr.base.ref}
${pr.body ? `\n**Description:**\n${pr.body.slice(0, 500)}${pr.body.length > 500 ? '...' : ''}` : ''}

Should I review this PR?`;

    await notifyJean(message, {
      type: 'pull_request',
      action,
      repo,
      pr_number: pr.number,
      branch: pr.head.ref,
    });
  }
}

// PR review submitted
async function handlePullRequestReview(payload) {
  const { action, review, pull_request, repository } = payload;
  
  if (action === 'submitted' && review.state !== 'commented') {
    const message = `📝 **PR Review:** [${repository.full_name}#${pull_request.number}](${pull_request.html_url})
**Reviewer:** ${review.user.login}
**State:** ${review.state}
${review.body ? `**Comment:** ${review.body}` : ''}`;

    await notifyJean(message, {
      type: 'pull_request_review',
      repo: repository.full_name,
      pr_number: pull_request.number,
    });
  }
}

// Line comment on PR
async function handlePullRequestReviewComment(payload) {
  const { action, comment, pull_request, repository } = payload;
  
  if (action === 'created') {
    const message = `💬 **PR Comment:** [${repository.full_name}#${pull_request.number}](${comment.html_url})
**File:** \`${comment.path}\` (line ${comment.line || comment.original_line})
**From:** ${comment.user.login}
**Comment:** ${comment.body}

---
**Code context:**
\`\`\`
${comment.diff_hunk || 'No diff context'}
\`\`\`

Please review and respond to this comment.`;

    await notifyJean(message, {
      type: 'pull_request_review_comment',
      repo: repository.full_name,
      pr_number: pull_request.number,
      comment_id: comment.id,
      file: comment.path,
      line: comment.line || comment.original_line,
    });
  }
}

// Issue or PR comment (not line-specific)
async function handleIssueComment(payload) {
  const { action, issue, comment, repository } = payload;
  
  // Check for /review command
  if (action === 'created' && comment.body.toLowerCase().includes('/review')) {
    const message = `🤖 **Review requested:** [${repository.full_name}#${issue.number}](${issue.html_url})
**By:** ${comment.user.login}
**Command:** ${comment.body}

${issue.pull_request ? 'This is a PR - I should review it.' : 'This is an issue, not a PR.'}`;

    await notifyJean(message, {
      type: 'review_command',
      repo: repository.full_name,
      issue_number: issue.number,
      is_pr: !!issue.pull_request,
    });
  }
}

// Check suite completed
async function handleCheckSuite(payload) {
  const { action, check_suite, repository } = payload;
  
  if (action === 'completed' && check_suite.conclusion === 'failure') {
    const message = `❌ **CI Failed:** ${repository.full_name}
**Branch:** ${check_suite.head_branch}
**Conclusion:** ${check_suite.conclusion}
**Commit:** ${check_suite.head_sha.slice(0, 7)}

Should I investigate the failure?`;

    await notifyJean(message, {
      type: 'check_suite_failure',
      repo: repository.full_name,
      branch: check_suite.head_branch,
      sha: check_suite.head_sha,
    });
  }
}

// Deployment status changed
async function handleDeploymentStatus(payload) {
  const { deployment_status, deployment, repository } = payload;
  
  if (deployment_status.state === 'success') {
    const message = `🚀 **Deployed:** ${repository.full_name}
**Environment:** ${deployment.environment}
**Ref:** ${deployment.ref}
**URL:** ${deployment_status.target_url || 'N/A'}

Should I run post-deploy verification?`;

    await notifyJean(message, {
      type: 'deployment_success',
      repo: repository.full_name,
      environment: deployment.environment,
      url: deployment_status.target_url,
    });
  }
}

// Verify gateway connectivity at startup
async function verifyGatewayConnection() {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.warn('⚠️  Gateway not configured (OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN missing)');
    console.warn('   Running in mock mode - notifications will be logged only');
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
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (response.ok) {
      const result = await response.json();
      console.log('✅ Gateway connection verified');
      console.log(`   Model: ${result.model || 'default'}`);
      return true;
    } else {
      const error = await response.text();
      console.error(`❌ Gateway returned ${response.status}: ${error}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Gateway connection failed: ${error.message}`);
    console.error(`   URL: ${OPENCLAW_GATEWAY_URL}`);
    console.error('   Check network connectivity and gateway configuration');
    return false;
  }
}

// Start server
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`jean-ci v0.1.0 starting...`);
  console.log(`${'='.repeat(50)}\n`);
  
  console.log(`📡 Webhook URL: https://jean-ci.telegraphic.app/webhook`);
  console.log(`🔧 Port: ${PORT}`);
  console.log(`🔑 GitHub App ID: ${APP_ID}`);
  console.log('');
  
  const gatewayOk = await verifyGatewayConnection();
  
  console.log('');
  console.log(`${'='.repeat(50)}`);
  console.log(`Status: ${gatewayOk ? '🟢 READY' : '🟡 READY (mock mode)'}`);
  console.log(`${'='.repeat(50)}\n`);
});
