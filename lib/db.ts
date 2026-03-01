import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: DATABASE_URL });

// System prompt (fixed)
export const SYSTEM_PROMPT = `You are an automated code reviewer for a CI pipeline.

## Your Task
Analyze the pull request and determine if it should PASS or FAIL based on the review criteria provided.

## Output Format (REQUIRED)
Your response MUST start with one of these exact strings:
- **VERDICT: PASS** - if the code meets all criteria
- **VERDICT: FAIL** - if there are blocking issues

After the verdict, provide a brief explanation (2-5 bullet points max).

## Rules
1. Be objective and consistent
2. Focus on the criteria provided
3. Do not suggest improvements unless they are blocking issues
4. When in doubt, FAIL - it's safer to ask for fixes than to let bugs through`;

// Default user prompt
export const DEFAULT_USER_PROMPT = `## Review Criteria

### Automatic FAIL (blocking issues):
- Security vulnerabilities (SQL injection, XSS, exposed secrets, hardcoded credentials)
- Code that will crash or throw unhandled exceptions in production
- Breaking changes without migration path
- Incomplete implementations (placeholder code, TODO without issue reference)
- Test/debug code that shouldn't be merged to production

### Automatic PASS:
- Code is production-ready
- Changes are coherent and complete
- No security issues
- Error handling is appropriate

### Not blocking (don't fail for these):
- Style preferences
- Minor refactoring suggestions
- Documentation improvements (unless critically missing)
- Performance optimizations (unless severe)

Be pragmatic. The goal is to catch real problems, not to be pedantic.`;

// Event retention
export const MAX_EVENTS = 10000;

// Initialize database
export async function initDatabase() {
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
        delivery_id TEXT,
        repo TEXT,
        action TEXT,
        payload JSONB,
        processed BOOLEAN DEFAULT FALSE,
        source TEXT DEFAULT 'github',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add source column if it doesn't exist (migration)
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jean_ci_webhook_events' AND column_name='source') THEN
          ALTER TABLE jean_ci_webhook_events ADD COLUMN source TEXT DEFAULT 'github';
        END IF;
      END $$;

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

      CREATE TABLE IF NOT EXISTS jean_ci_pending_deployments (
        id SERIAL PRIMARY KEY,
        app_uuid TEXT UNIQUE NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        head_sha TEXT,
        deployment_id BIGINT,
        check_run_id BIGINT,
        coolify_deployment_uuid TEXT,
        logs_url TEXT,
        app_url TEXT,
        installation_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Migration: add coolify_deployment_uuid if missing
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'jean_ci_pending_deployments' AND column_name = 'coolify_deployment_uuid') THEN
          ALTER TABLE jean_ci_pending_deployments ADD COLUMN coolify_deployment_uuid TEXT;
        END IF;
      END $$;
    `);

    // Migration: rename global_prompt -> user_prompt
    await client.query(`
      UPDATE jean_ci_config SET key = 'user_prompt' WHERE key = 'global_prompt'
    `);

    await client.query(`
      INSERT INTO jean_ci_config (key, value) 
      VALUES ('user_prompt', $1) 
      ON CONFLICT (key) DO NOTHING
    `, [DEFAULT_USER_PROMPT]);

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// Config helpers
export async function getConfig(key: string): Promise<string | null> {
  const result = await pool.query('SELECT value FROM jean_ci_config WHERE key = $1', [key]);
  return result.rows[0]?.value || null;
}

export async function setConfig(key: string, value: string) {
  await pool.query(`
    INSERT INTO jean_ci_config (key, value, updated_at) 
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
  `, [key, value]);
}

// Repo helpers
export interface Repo {
  id: number;
  full_name: string;
  installation_id: number;
  pr_review_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function getRepo(fullName: string): Promise<Repo | null> {
  const result = await pool.query('SELECT * FROM jean_ci_repos WHERE full_name = $1', [fullName]);
  return result.rows[0] || null;
}

export async function upsertRepo(fullName: string, installationId: number, prReviewEnabled = false) {
  await pool.query(`
    INSERT INTO jean_ci_repos (full_name, installation_id, pr_review_enabled, updated_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (full_name) DO UPDATE SET 
      installation_id = $2,
      updated_at = CURRENT_TIMESTAMP
  `, [fullName, installationId, prReviewEnabled]);
}

export async function setRepoReviewEnabled(fullName: string, enabled: boolean) {
  await pool.query(`
    UPDATE jean_ci_repos SET pr_review_enabled = $1, updated_at = CURRENT_TIMESTAMP 
    WHERE full_name = $2
  `, [enabled, fullName]);
}

export async function getAllRepos(): Promise<Repo[]> {
  const result = await pool.query('SELECT * FROM jean_ci_repos ORDER BY full_name');
  return result.rows;
}

// Check run helpers
export interface CheckRun {
  id: number;
  github_check_id?: number;
  repo: string;
  pr_number: number;
  check_name: string;
  head_sha?: string;
  status: string;
  conclusion?: string;
  title?: string;
  summary?: string;
  prompt?: string;
  pr_title?: string;
  pr_body?: string;
  diff_preview?: string;
  created_at: Date;
  completed_at?: Date;
}

export async function insertCheckRun(data: {
  github_check_id?: number;
  repo: string;
  pr_number: number;
  check_name: string;
  head_sha?: string;
  prompt?: string;
  pr_title?: string;
  pr_body?: string;
  diff_preview?: string;
}): Promise<number> {
  const result = await pool.query(`
    INSERT INTO jean_ci_check_runs 
    (github_check_id, repo, pr_number, check_name, head_sha, status, prompt, pr_title, pr_body, diff_preview)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [data.github_check_id, data.repo, data.pr_number, data.check_name, data.head_sha, 
      'queued', data.prompt, data.pr_title, data.pr_body, data.diff_preview]);
  return result.rows[0].id;
}

export async function updateCheckRun(id: number, data: {
  status?: string;
  conclusion?: string;
  title?: string;
  summary?: string;
  completed_at?: Date;
}) {
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

export async function setCheckRunGithubId(id: number, githubCheckId: number) {
  await pool.query('UPDATE jean_ci_check_runs SET github_check_id = $1 WHERE id = $2', [githubCheckId, id]);
}

export async function getCheckRun(id: number): Promise<CheckRun | null> {
  const result = await pool.query('SELECT * FROM jean_ci_check_runs WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Event helpers
export interface WebhookEvent {
  id: number;
  event_type: string;
  delivery_id?: string;
  repo?: string;
  action?: string;
  processed: boolean;
  created_at: Date;
}

export async function insertEvent(eventType: string, deliveryId: string | null, repo: string | null, action: string | null, payload: any, source: string = 'github') {
  try {
    await pool.query(`
      INSERT INTO jean_ci_webhook_events (event_type, delivery_id, repo, action, payload, source)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [eventType, deliveryId, repo, action, JSON.stringify(payload), source]);
  } catch (e) {
    // Duplicate delivery - ignore
  }
}

export async function getRecentEvents(limit = 50): Promise<WebhookEvent[]> {
  const result = await pool.query(`
    SELECT id, event_type, delivery_id, repo, action, processed, created_at 
    FROM jean_ci_webhook_events 
    ORDER BY created_at DESC 
    LIMIT $1
  `, [limit]);
  return result.rows;
}

export async function cleanupOldEvents(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM jean_ci_webhook_events 
    WHERE id NOT IN (
      SELECT id FROM jean_ci_webhook_events 
      ORDER BY created_at DESC 
      LIMIT $1
    )
  `, [MAX_EVENTS]);
  if (result.rowCount && result.rowCount > 0) {
    console.log(`🧹 Cleaned up ${result.rowCount} old events`);
  }
  return result.rowCount || 0;
}

export async function getCheckRunsByRepo(repo: string, limit = 50): Promise<CheckRun[]> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_check_runs WHERE repo = $1 ORDER BY created_at DESC LIMIT $2',
    [repo, limit]
  );
  return result.rows;
}


export async function getDeploymentsByRepo(repo: string, limit = 20): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM jean_ci_webhook_events 
     WHERE repo = $1 
     AND (event_type = 'deployment_status' 
          OR event_type = 'registry_package' 
          OR event_type = 'workflow_run'
          OR event_type LIKE 'coolify_%')
     ORDER BY created_at DESC
     LIMIT $2`,
    [repo, limit]
  );
  return result.rows;
}

export async function getAllDeployments(limit = 100): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM jean_ci_webhook_events 
     WHERE event_type = 'deployment_status' 
        OR event_type = 'registry_package' 
        OR event_type = 'workflow_run'
        OR event_type LIKE 'coolify_%'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getAllCheckRuns(limit = 100): Promise<CheckRun[]> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_check_runs ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}
export async function getEventsByRepo(repo: string, limit = 100): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM jean_ci_webhook_events 
     WHERE repo = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [repo, limit]
  );
  return result.rows;
}

// Pagination helpers
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function getEventsByRepoCount(repo: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) FROM jean_ci_webhook_events WHERE repo = $1',
    [repo]
  );
  return parseInt(result.rows[0].count);
}

export async function getEventsByRepoPaginated(repo: string, page = 1, limit = 50): Promise<PaginatedResult<any>> {
  const offset = (page - 1) * limit;
  const [items, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM jean_ci_webhook_events 
       WHERE repo = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [repo, limit, offset]
    ),
    pool.query('SELECT COUNT(*) FROM jean_ci_webhook_events WHERE repo = $1', [repo])
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getCheckRunsByRepoCount(repo: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) FROM jean_ci_check_runs WHERE repo = $1',
    [repo]
  );
  return parseInt(result.rows[0].count);
}

export async function getCheckRunsByRepoPaginated(repo: string, page = 1, limit = 50): Promise<PaginatedResult<CheckRun>> {
  const offset = (page - 1) * limit;
  const [items, countResult] = await Promise.all([
    pool.query(
      'SELECT * FROM jean_ci_check_runs WHERE repo = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [repo, limit, offset]
    ),
    pool.query('SELECT COUNT(*) FROM jean_ci_check_runs WHERE repo = $1', [repo])
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getDeploymentsByRepoCount(repo: string): Promise<number> {
  // Only count Coolify deployments (jean-ci triggered)
  const result = await pool.query(
    `SELECT COUNT(*) FROM jean_ci_webhook_events 
     WHERE repo = $1 
     AND event_type LIKE 'coolify_%'`,
    [repo]
  );
  return parseInt(result.rows[0].count);
}

export async function getDeploymentsByRepoPaginated(repo: string, page = 1, limit = 50): Promise<PaginatedResult<any>> {
  const offset = (page - 1) * limit;
  // Only show Coolify deployments (jean-ci triggered)
  const [items, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM jean_ci_webhook_events 
       WHERE repo = $1 
       AND event_type LIKE 'coolify_%'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [repo, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM jean_ci_webhook_events 
       WHERE repo = $1 
       AND event_type LIKE 'coolify_%'`,
      [repo]
    )
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getAllDeploymentsCount(): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) FROM jean_ci_webhook_events 
     WHERE event_type = 'deployment_status' 
        OR event_type = 'registry_package' 
        OR event_type = 'workflow_run'
        OR event_type LIKE 'coolify_%'`
  );
  return parseInt(result.rows[0].count);
}

export async function getAllDeploymentsPaginated(page = 1, limit = 50): Promise<PaginatedResult<any>> {
  const offset = (page - 1) * limit;
  // Only show Coolify deployments (jean-ci triggered)
  const [items, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM jean_ci_webhook_events 
       WHERE event_type LIKE 'coolify_%'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM jean_ci_webhook_events 
       WHERE event_type LIKE 'coolify_%'`
    )
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getAllCheckRunsCount(): Promise<number> {
  const result = await pool.query('SELECT COUNT(*) FROM jean_ci_check_runs');
  return parseInt(result.rows[0].count);
}

export async function getAllCheckRunsPaginated(page = 1, limit = 50): Promise<PaginatedResult<CheckRun>> {
  const offset = (page - 1) * limit;
  const [items, countResult] = await Promise.all([
    pool.query(
      'SELECT * FROM jean_ci_check_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    ),
    pool.query('SELECT COUNT(*) FROM jean_ci_check_runs')
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getRecentEventsPaginated(page = 1, limit = 50, eventType?: string): Promise<PaginatedResult<WebhookEvent>> {
  const offset = (page - 1) * limit;
  
  let query = `SELECT id, event_type, delivery_id, repo, action, processed, source, created_at 
               FROM jean_ci_webhook_events`;
  let countQuery = 'SELECT COUNT(*) FROM jean_ci_webhook_events';
  const params: any[] = [];
  const countParams: any[] = [];
  
  if (eventType) {
    query += ` WHERE event_type = $1`;
    countQuery += ` WHERE event_type = $1`;
    params.push(eventType);
    countParams.push(eventType);
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  
  const [items, countResult] = await Promise.all([
    pool.query(query, params),
    pool.query(countQuery, countParams)
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getEventTypes(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT event_type FROM jean_ci_webhook_events ORDER BY event_type`
  );
  return result.rows.map(r => r.event_type);
}

// Pipeline aggregation types
export interface PipelineStage {
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped';
  timestamp?: string;
  url?: string;
}

export interface Pipeline {
  sha: string;
  shortSha: string;
  repo: string;
  message?: string;
  author?: string;
  build: PipelineStage;
  package: PipelineStage;
  deploy: PipelineStage;
  createdAt: string;
}

export async function getDeploymentPipelines(page = 1, limit = 20): Promise<PaginatedResult<Pipeline>> {
  // Get recent deployment-related events
  // Filter workflow_run to only build/deploy workflows in SQL for proper pagination
  const result = await pool.query(
    `SELECT id, event_type, repo, action, payload, created_at 
     FROM jean_ci_webhook_events 
     WHERE (
       event_type IN ('registry_package', 'coolify_deployment_success', 'coolify_deployment_failed', 'coolify_deployment_started')
       OR (
         event_type = 'workflow_run' 
         AND (
           LOWER(payload->'workflow_run'->>'name') LIKE '%build%'
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%deploy%'
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%release%'
         )
         AND LOWER(payload->'workflow_run'->>'name') NOT LIKE '%test%'
       )
     )
     ORDER BY created_at DESC
     LIMIT 500` // Fetch enough to build pipeline history
  );

  // Group by commit SHA
  const pipelineMap = new Map<string, Pipeline>();

  for (const row of result.rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    
    // Extract SHA from different event types
    let sha: string | undefined;
    let repo = row.repo;
    let message: string | undefined;
    let author: string | undefined;
    let url: string | undefined;

    if (row.event_type === 'workflow_run') {
      // Build/deploy filter already applied in SQL query
      sha = payload?.workflow_run?.head_sha;
      message = payload?.workflow_run?.head_commit?.message?.split('\n')[0];
      author = payload?.workflow_run?.head_commit?.author?.name || payload?.sender?.login;
      url = payload?.workflow_run?.html_url;
      repo = payload?.repository?.full_name || repo;
    } else if (row.event_type === 'registry_package') {
      sha = payload?.registry_package?.package_version?.target_oid;
      url = payload?.registry_package?.package_version?.html_url;
      repo = payload?.repository?.full_name || repo;
    } else if (row.event_type?.startsWith('coolify_')) {
      // Coolify events might have SHA in _source_sha or we need to match by timing
      sha = payload?._source_sha || payload?.commit_sha;
      url = payload?.deployment_url;
      repo = payload?._source_repo || repo;
    }

    if (!sha) continue;
    // Allow events without full repo name (Coolify falls back to app name)
    if (!repo) repo = 'unknown';

    const shortSha = sha.substring(0, 7);
    
    // Try to find existing pipeline by SHA (handles partial repo names like "jean-ci" vs "telegraphic-dev/jean-ci")
    let existingKey: string | undefined;
    for (const [k, p] of pipelineMap.entries()) {
      if (p.sha === sha) {
        existingKey = k;
        break;
      }
    }
    
    // Use existing key if found, otherwise create new with best available repo name
    // Prefer full repo names (containing "/") over partial names
    let key: string;
    if (existingKey) {
      key = existingKey;
      // If current event has full repo name and existing doesn't, update it
      const existingPipeline = pipelineMap.get(existingKey)!;
      if (repo.includes('/') && !existingPipeline.repo.includes('/')) {
        existingPipeline.repo = repo;
      }
    } else {
      key = `${repo}:${sha}`;
      pipelineMap.set(key, {
        sha,
        shortSha,
        repo,
        message,
        author,
        build: { status: 'pending' },
        package: { status: 'pending' },
        deploy: { status: 'pending' },
        createdAt: row.created_at,
      });
    }

    const pipeline = pipelineMap.get(key)!;
    // Update repo to full name if we have it
    if (repo.includes('/') && !pipeline.repo.includes('/')) {
      pipeline.repo = repo;
    }
    if (message && !pipeline.message) pipeline.message = message;
    if (author && !pipeline.author) pipeline.author = author;

    // Update stage status (only upgrade status, never downgrade)
    // Events are ordered newest-first, so we see completed before in_progress
    if (row.event_type === 'workflow_run') {
      const action = row.action || payload?.action;
      const conclusion = payload?.workflow_run?.conclusion;
      const status = payload?.workflow_run?.status;
      
      // Only update build if we have a better status
      const currentStatus = pipeline.build.status;
      let newStatus: 'pending' | 'running' | 'success' | 'failure' = 'pending';
      
      if (action === 'completed' && conclusion) {
        newStatus = conclusion === 'success' ? 'success' : 'failure';
      } else if (status === 'in_progress') {
        newStatus = 'running';
      }
      
      // Priority: success/failure > running > pending
      const priority: Record<string, number> = { pending: 0, running: 1, success: 2, failure: 2, skipped: 0 };
      if (priority[newStatus] >= priority[currentStatus]) {
        pipeline.build = { status: newStatus, timestamp: row.created_at, url };
      }
    } else if (row.event_type === 'registry_package') {
      pipeline.package = {
        status: 'success',
        timestamp: row.created_at,
        url,
      };
    } else if (row.event_type === 'coolify_deployment_success') {
      pipeline.deploy = {
        status: 'success',
        timestamp: row.created_at,
        url,
      };
    } else if (row.event_type === 'coolify_deployment_failed') {
      pipeline.deploy = {
        status: 'failure',
        timestamp: row.created_at,
        url,
      };
    } else if (row.event_type === 'coolify_deployment_started') {
      if (pipeline.deploy.status === 'pending') {
        pipeline.deploy = {
          status: 'running',
          timestamp: row.created_at,
          url,
        };
      }
    }
  }

  // Enhance pending deploys with Coolify deployment links
  const pendingDeploys = await getAllPendingDeployments();
  for (const pipeline of pipelineMap.values()) {
    if (pipeline.deploy.status === 'pending' && pipeline.package.status === 'success') {
      // This pipeline has a package but deploy is pending - check for in-flight deployment
      const pending = pendingDeploys.find(p => p.head_sha === pipeline.sha);
      if (pending?.coolify_deployment_uuid) {
        pipeline.deploy = {
          status: 'running',
          timestamp: pending.created_at?.toISOString(),
          url: buildCoolifyDeploymentUrl(pending.app_uuid, pending.coolify_deployment_uuid, pending.logs_url),
        };
      }
    }
  }

  // Sort by most recent
  const allPipelines = Array.from(pipelineMap.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const total = allPipelines.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = allPipelines.slice(offset, offset + limit);
  
  return { items, total, page, limit, totalPages };
}

export async function getDeploymentPipelinesByRepo(repo: string, page = 1, limit = 20): Promise<PaginatedResult<Pipeline>> {
  // Get deployment-related events for this repo
  // Filter workflow_run to only build/deploy workflows in SQL
  const result = await pool.query(
    `SELECT id, event_type, repo, action, payload, created_at 
     FROM jean_ci_webhook_events 
     WHERE repo = $1
     AND (
       event_type IN ('registry_package', 'coolify_deployment_success', 'coolify_deployment_failed', 'coolify_deployment_started')
       OR (
         event_type = 'workflow_run' 
         AND (
           LOWER(payload->'workflow_run'->>'name') LIKE '%build%'
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%deploy%'
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%release%'
         )
         AND LOWER(payload->'workflow_run'->>'name') NOT LIKE '%test%'
       )
     )
     ORDER BY created_at DESC
     LIMIT 200`,
    [repo]
  );

  // Group by commit SHA
  const pipelineMap = new Map<string, Pipeline>();

  for (const row of result.rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    
    let sha: string | undefined;
    let message: string | undefined;
    let author: string | undefined;
    let url: string | undefined;

    if (row.event_type === 'workflow_run') {
      // Build/deploy filter already applied in SQL query
      sha = payload?.workflow_run?.head_sha;
      message = payload?.workflow_run?.head_commit?.message?.split('\n')[0];
      author = payload?.workflow_run?.head_commit?.author?.name || payload?.sender?.login;
      url = payload?.workflow_run?.html_url;
    } else if (row.event_type === 'registry_package') {
      sha = payload?.registry_package?.package_version?.target_oid;
      url = payload?.registry_package?.package_version?.html_url;
    } else if (row.event_type?.startsWith('coolify_')) {
      sha = payload?._source_sha;
      url = payload?.deployment_url;
    }

    if (!sha) continue;

    const shortSha = sha.substring(0, 7);
    const key = sha;

    if (!pipelineMap.has(key)) {
      pipelineMap.set(key, {
        sha,
        shortSha,
        repo,
        message,
        author,
        build: { status: 'pending' },
        package: { status: 'pending' },
        deploy: { status: 'pending' },
        createdAt: row.created_at,
      });
    }

    const pipeline = pipelineMap.get(key)!;
    if (message && !pipeline.message) pipeline.message = message;
    if (author && !pipeline.author) pipeline.author = author;

    if (row.event_type === 'workflow_run') {
      const action = row.action || payload?.action;
      const conclusion = payload?.workflow_run?.conclusion;
      const status = payload?.workflow_run?.status;
      
      const currentStatus = pipeline.build.status;
      let newStatus: 'pending' | 'running' | 'success' | 'failure' = 'pending';
      
      if (action === 'completed' && conclusion) {
        newStatus = conclusion === 'success' ? 'success' : 'failure';
      } else if (status === 'in_progress') {
        newStatus = 'running';
      }
      
      const priority: Record<string, number> = { pending: 0, running: 1, success: 2, failure: 2, skipped: 0 };
      if (priority[newStatus] >= priority[currentStatus]) {
        pipeline.build = { status: newStatus, timestamp: row.created_at, url };
      }
    } else if (row.event_type === 'registry_package') {
      pipeline.package = { status: 'success', timestamp: row.created_at, url };
    } else if (row.event_type === 'coolify_deployment_success') {
      pipeline.deploy = { status: 'success', timestamp: row.created_at, url };
    } else if (row.event_type === 'coolify_deployment_failed') {
      pipeline.deploy = { status: 'failure', timestamp: row.created_at, url };
    }
  }

  const allPipelines = Array.from(pipelineMap.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const total = allPipelines.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = allPipelines.slice(offset, offset + limit);
  
  return { items, total, page, limit, totalPages };
}

export interface RepoWithActivity extends Repo {
  last_activity?: string;
}

export async function getReposWithActivity(): Promise<RepoWithActivity[]> {
  const result = await pool.query(`
    SELECT r.*, 
      (SELECT MAX(e.created_at) FROM jean_ci_webhook_events e WHERE e.repo = r.full_name) as last_activity
    FROM jean_ci_repos r
    ORDER BY r.full_name
  `);
  return result.rows;
}

// Pending Deployments - persisted to DB instead of in-memory Map
export interface PendingDeployment {
  id?: number;
  app_uuid: string;
  owner: string;
  repo: string;
  head_sha?: string;
  deployment_id?: number;
  check_run_id?: number;
  coolify_deployment_uuid?: string;
  logs_url: string;
  app_url: string;
  installation_id: number;
  created_at?: Date;
}

export async function savePendingDeployment(pd: PendingDeployment): Promise<void> {
  await pool.query(
    `INSERT INTO jean_ci_pending_deployments 
     (app_uuid, owner, repo, head_sha, deployment_id, check_run_id, coolify_deployment_uuid, logs_url, app_url, installation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (app_uuid) DO UPDATE SET
       owner = EXCLUDED.owner,
       repo = EXCLUDED.repo,
       head_sha = EXCLUDED.head_sha,
       deployment_id = EXCLUDED.deployment_id,
       check_run_id = EXCLUDED.check_run_id,
       coolify_deployment_uuid = EXCLUDED.coolify_deployment_uuid,
       logs_url = EXCLUDED.logs_url,
       app_url = EXCLUDED.app_url,
       installation_id = EXCLUDED.installation_id,
       created_at = CURRENT_TIMESTAMP`,
    [pd.app_uuid, pd.owner, pd.repo, pd.head_sha, pd.deployment_id, pd.check_run_id, pd.coolify_deployment_uuid, pd.logs_url, pd.app_url, pd.installation_id]
  );
}

export async function getPendingDeployment(appUuid: string): Promise<PendingDeployment | null> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_pending_deployments WHERE app_uuid = $1',
    [appUuid]
  );
  return result.rows[0] || null;
}

export async function deletePendingDeployment(appUuid: string): Promise<void> {
  await pool.query('DELETE FROM jean_ci_pending_deployments WHERE app_uuid = $1', [appUuid]);
}

export async function cleanupStalePendingDeployments(maxAgeMinutes = 30): Promise<number> {
  const result = await pool.query(
    `DELETE FROM jean_ci_pending_deployments 
     WHERE created_at < NOW() - INTERVAL '1 minute' * $1
     RETURNING id`,
    [maxAgeMinutes]
  );
  return result.rowCount || 0;
}

export async function getAllPendingDeployments(): Promise<PendingDeployment[]> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_pending_deployments ORDER BY created_at DESC'
  );
  return result.rows;
}

export function buildCoolifyDeploymentUrl(appUuid: string, deploymentUuid: string, logsUrl?: string): string {
  // If we have the logs URL, try to extract project/env info from it
  // Format: https://apps.telegraphic.app/project/{projectUuid}/environment/{envUuid}/application/{appUuid}/deployment/{deploymentUuid}
  if (logsUrl) {
    const match = logsUrl.match(/\/project\/([^/]+)\/([^/]+)\/application\/[^/]+$/);
    if (match) {
      return `${logsUrl.split('/project/')[0]}/project/${match[1]}/${match[2]}/application/${appUuid}/deployment/${deploymentUuid}`;
    }
  }
  // Fallback - just link to the deployment directly
  const coolifyUrl = process.env.COOLIFY_DASHBOARD_URL || 'https://apps.telegraphic.app';
  return `${coolifyUrl}/deployments/${deploymentUuid}`;
}
