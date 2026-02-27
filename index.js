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

// Event queue for Jean to poll
const eventQueue = [];
const MAX_QUEUE_SIZE = 100;

// Send message to Jean via queue (polled by Jean)
async function notifyJean(message, context = {}) {
  const event = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    message,
    context,
  };
  
  eventQueue.push(event);
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue.shift(); // Remove oldest
  }
  
  console.log(`[QUEUED] ${context.type || 'unknown'}: ${event.id}`);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'jean-ci', version: '0.1.0' });
});

// Get queued events (for Jean to poll)
app.get('/events', (req, res) => {
  // Simple auth check
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== OPENCLAW_GATEWAY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const events = [...eventQueue];
  res.json({ events, count: events.length });
});

// Clear events after processing
app.delete('/events', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== OPENCLAW_GATEWAY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const cleared = eventQueue.length;
  eventQueue.length = 0;
  res.json({ cleared });
});

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

// Start server
app.listen(PORT, () => {
  console.log(`jean-ci listening on port ${PORT}`);
  console.log(`Webhook URL: https://jean-ci.telegraphic.app/webhook`);
});
