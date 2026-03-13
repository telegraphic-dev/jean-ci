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
export const MAX_EVENTS = 20000;

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

      CREATE TABLE IF NOT EXISTS jean_ci_pr_reviews (
        id SERIAL PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        last_reviewed_sha TEXT,
        is_draft BOOLEAN DEFAULT FALSE,
        draft_reviewed BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (repo, pr_number)
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

      -- Coolify app → GitHub repo mapping
      -- Updated on each successful registry_package → Coolify deployment
      CREATE TABLE IF NOT EXISTS jean_ci_app_mappings (
        id SERIAL PRIMARY KEY,
        coolify_app_uuid TEXT UNIQUE NOT NULL,
        github_repo TEXT NOT NULL,
        coolify_app_name TEXT,
        coolify_app_fqdn TEXT,
        installation_id INTEGER,
        last_deployed_sha TEXT,
        last_deployed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_jean_ci_app_mappings_repo ON jean_ci_app_mappings(github_repo);
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

export interface PRReviewState {
  pr_number: number;
  repo: string;
  last_reviewed_sha?: string;
  is_draft: boolean;
  draft_reviewed: boolean;
  updated_at: Date;
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

export async function getPRReviewState(repo: string, prNumber: number): Promise<PRReviewState | null> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_pr_reviews WHERE repo = $1 AND pr_number = $2',
    [repo, prNumber]
  );
  return result.rows[0] || null;
}

export async function upsertPRReviewState(data: {
  pr_number: number;
  repo: string;
  last_reviewed_sha?: string;
  is_draft: boolean;
  draft_reviewed: boolean;
}) {
  await pool.query(`
    INSERT INTO jean_ci_pr_reviews
    (pr_number, repo, last_reviewed_sha, is_draft, draft_reviewed, updated_at)
    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (repo, pr_number) DO UPDATE SET
      last_reviewed_sha = $3,
      is_draft = $4,
      draft_reviewed = $5,
      updated_at = CURRENT_TIMESTAMP
  `, [data.pr_number, data.repo, data.last_reviewed_sha || null, data.is_draft, data.draft_reviewed]);
}

export async function getAllPRReviewsForRepo(repo: string): Promise<{ pr_number: number; last_reviewed_sha?: string }[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (pr_number) pr_number, last_reviewed_sha
     FROM jean_ci_pr_reviews 
     WHERE repo = $1
     ORDER BY pr_number, updated_at DESC`,
    [repo]
  );
  return result.rows;
}

export async function deletePRReview(repo: string, prNumber: number): Promise<void> {
  await pool.query(
    'DELETE FROM jean_ci_pr_reviews WHERE repo = $1 AND pr_number = $2',
    [repo, prNumber]
  );
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
  } catch (e: any) {
    // 23505 = unique_violation (duplicate delivery_id)
    if (e?.code === '23505') {
      console.log(`[Event] Duplicate delivery ignored: ${eventType} ${deliveryId}`);
    } else {
      console.error(`[Event] Failed to insert ${eventType}:`, e?.message || e);
    }
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
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%publish%'
         )
         AND LOWER(payload->'workflow_run'->>'name') NOT LIKE '%test%'
       )
     )
     ORDER BY created_at DESC
     LIMIT 500` // Fetch enough to build pipeline history
  );

  // Group by commit SHA
  const pipelineMap = new Map<string, Pipeline>();

  // Build a lookup from deployment_uuid -> source SHA/repo using started events
  // This lets us recover SHA even when success/failed webhooks arrive without _source_sha.
  const deploymentSourceByUuid = new Map<string, { sha?: string; repo?: string }>();
  for (const row of result.rows) {
    if (row.event_type !== 'coolify_deployment_started') continue;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const deploymentUuid = payload?.deployment_uuid || payload?.deploymentUuid || payload?.deployment_id || payload?.deploymentId;
    if (!deploymentUuid) continue;
    deploymentSourceByUuid.set(String(deploymentUuid), {
      sha: payload?._source_sha || payload?.commit_sha,
      repo: payload?._source_repo || row.repo,
    });
  }

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
      // Coolify events should carry _source_sha, but can occasionally miss it.
      // Fall back to deployment_uuid -> started-event lookup.
      const deploymentUuid = payload?.deployment_uuid || payload?.deploymentUuid || payload?.deployment_id || payload?.deploymentId;
      const source = deploymentUuid ? deploymentSourceByUuid.get(String(deploymentUuid)) : undefined;
      sha = payload?._source_sha || payload?.commit_sha || source?.sha;
      url = payload?.deployment_url;
      repo = payload?._source_repo || source?.repo || repo;
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
           OR LOWER(payload->'workflow_run'->>'name') LIKE '%publish%'
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

  // Build deployment_uuid -> SHA lookup from started events (repo-scoped query)
  const deploymentSourceByUuid = new Map<string, { sha?: string }>();
  for (const row of result.rows) {
    if (row.event_type !== 'coolify_deployment_started') continue;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const deploymentUuid = payload?.deployment_uuid || payload?.deploymentUuid || payload?.deployment_id || payload?.deploymentId;
    if (!deploymentUuid) continue;
    deploymentSourceByUuid.set(String(deploymentUuid), {
      sha: payload?._source_sha || payload?.commit_sha,
    });
  }

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
      const deploymentUuid = payload?.deployment_uuid || payload?.deploymentUuid || payload?.deployment_id || payload?.deploymentId;
      const source = deploymentUuid ? deploymentSourceByUuid.get(String(deploymentUuid)) : undefined;
      sha = payload?._source_sha || payload?.commit_sha || source?.sha;
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

export async function getPendingDeploymentByDeploymentUuid(deploymentUuid: string): Promise<PendingDeployment | null> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_pending_deployments WHERE coolify_deployment_uuid = $1',
    [deploymentUuid]
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

export async function getReposWithPRReviewEnabled(): Promise<{ full_name: string; installation_id: number }[]> {
  const result = await pool.query(
    `SELECT full_name, installation_id FROM jean_ci_repos WHERE pr_review_enabled = TRUE ORDER BY full_name`
  );
  return result.rows;
}

export interface OpenPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  url: string;
  checkStatus: 'pending' | 'success' | 'failure';
  updatedAt: string;
}

export async function getLatestCheckForPR(repo: string, prNumber: number): Promise<{ status: string; conclusion?: string } | null> {
  const result = await pool.query(
    `SELECT status, conclusion FROM jean_ci_check_runs 
     WHERE repo = $1 AND pr_number = $2 
     ORDER BY created_at DESC LIMIT 1`,
    [repo, prNumber]
  );
  return result.rows[0] || null;
}

export async function getOpenPRsFromEvents(): Promise<OpenPR[]> {
  // Get latest PR events per repo/pr_number, excluding closed PRs
  const result = await pool.query(`
    WITH latest_pr_events AS (
      SELECT DISTINCT ON (repo, (payload->>'number')::int)
        repo,
        (payload->>'number')::int as pr_number,
        payload,
        created_at
      FROM jean_ci_webhook_events
      WHERE event_type = 'pull_request'
        AND repo IN (SELECT full_name FROM jean_ci_repos WHERE pr_review_enabled = TRUE)
      ORDER BY repo, (payload->>'number')::int, created_at DESC
    )
    SELECT * FROM latest_pr_events
    WHERE payload->>'action' != 'closed'
    ORDER BY created_at DESC
  `);

  const prs: OpenPR[] = [];
  
  for (const row of result.rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const pr = payload.pull_request || payload;
    
    // Get latest check status for this PR
    const check = await getLatestCheckForPR(row.repo, row.pr_number);
    
    let checkStatus: 'pending' | 'success' | 'failure' = 'pending';
    if (check) {
      if (check.status === 'completed') {
        checkStatus = check.conclusion === 'success' ? 'success' : 'failure';
      }
    }
    
    prs.push({
      repo: row.repo,
      number: row.pr_number,
      title: pr.title || `PR #${row.pr_number}`,
      author: pr.user?.login || payload.sender?.login || 'unknown',
      headSha: (pr.head?.sha || '').substring(0, 7),
      url: pr.html_url || `https://github.com/${row.repo}/pull/${row.pr_number}`,
      checkStatus,
      updatedAt: pr.updated_at || row.created_at,
    });
  }
  
  return prs;
}

// Sensitive fields to mask in event payloads
const SENSITIVE_PATTERNS = [
  /token/i, /secret/i, /password/i, /key/i, /auth/i, /credential/i,
  /email/i, /phone/i, /address/i, /ssn/i, /bearer/i
];

function maskSensitiveData(obj: any, depth = 0): any {
  if (depth > 10) return obj; // Prevent infinite recursion
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => maskSensitiveData(item, depth + 1));
  }
  
  const masked: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
    if (isSensitive && typeof value === 'string' && value.length > 0) {
      masked[key] = '***MASKED***';
    } else if (typeof value === 'object') {
      masked[key] = maskSensitiveData(value, depth + 1);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

export async function getEventById(id: number): Promise<{ event: any; payload: any } | null> {
  const result = await pool.query(
    `SELECT id, event_type, delivery_id, repo, action, payload, source, created_at 
     FROM jean_ci_webhook_events WHERE id = $1`,
    [id]
  );
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  
  return {
    event: {
      id: row.id,
      event_type: row.event_type,
      delivery_id: row.delivery_id,
      repo: row.repo,
      action: row.action,
      source: row.source,
      created_at: row.created_at,
    },
    payload: maskSensitiveData(payload),
  };
}

// Dashboard stats
export async function getOpenPRsCount(): Promise<number> {
  const result = await pool.query(`
    WITH latest_pr_events AS (
      SELECT DISTINCT ON (repo, (payload->>'number')::int)
        repo,
        (payload->>'number')::int as pr_number,
        payload->'pull_request'->>'state' as state
      FROM jean_ci_webhook_events
      WHERE event_type = 'pull_request'
      ORDER BY repo, (payload->>'number')::int, created_at DESC
    )
    SELECT COUNT(*) as count FROM latest_pr_events WHERE state = 'open'
  `);
  return parseInt(result.rows[0]?.count || '0', 10);
}

export async function getPendingDeploymentsCount(): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM jean_ci_pending_deployments'
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

// =============================================================================
// Coolify App Mappings
// =============================================================================

export interface AppMapping {
  id: number;
  coolify_app_uuid: string;
  github_repo: string;
  coolify_app_name: string | null;
  coolify_app_fqdn: string | null;
  installation_id: number | null;
  last_deployed_sha: string | null;
  last_deployed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertAppMapping(data: {
  coolify_app_uuid: string;
  github_repo: string;
  coolify_app_name?: string | null;
  coolify_app_fqdn?: string | null;
  installation_id?: number | null;
  last_deployed_sha?: string | null;
}): Promise<AppMapping> {
  const result = await pool.query(
    `INSERT INTO jean_ci_app_mappings 
       (coolify_app_uuid, github_repo, coolify_app_name, coolify_app_fqdn, installation_id, last_deployed_sha, last_deployed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (coolify_app_uuid) DO UPDATE SET
       github_repo = $2,
       coolify_app_name = COALESCE($3, jean_ci_app_mappings.coolify_app_name),
       coolify_app_fqdn = COALESCE($4, jean_ci_app_mappings.coolify_app_fqdn),
       installation_id = COALESCE($5, jean_ci_app_mappings.installation_id),
       last_deployed_sha = COALESCE($6, jean_ci_app_mappings.last_deployed_sha),
       last_deployed_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      data.coolify_app_uuid,
      data.github_repo,
      data.coolify_app_name || null,
      data.coolify_app_fqdn || null,
      data.installation_id || null,
      data.last_deployed_sha || null,
    ]
  );
  return result.rows[0];
}

export async function getAppMappingByUuid(coolifyAppUuid: string): Promise<AppMapping | null> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_app_mappings WHERE coolify_app_uuid = $1',
    [coolifyAppUuid]
  );
  return result.rows[0] || null;
}

export async function getAppMappingsByRepo(githubRepo: string): Promise<AppMapping[]> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_app_mappings WHERE github_repo = $1 ORDER BY updated_at DESC',
    [githubRepo]
  );
  return result.rows;
}

export async function getAllAppMappings(): Promise<AppMapping[]> {
  const result = await pool.query(
    'SELECT * FROM jean_ci_app_mappings ORDER BY updated_at DESC'
  );
  return result.rows;
}

// Get repo name for a Coolify app UUID (for enriching events)
export async function getRepoForApp(coolifyAppUuid: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT github_repo FROM jean_ci_app_mappings WHERE coolify_app_uuid = $1',
    [coolifyAppUuid]
  );
  return result.rows[0]?.github_repo || null;
}

// Get the most recent SHA from coolify_deployment_started event for an app
// Used as fallback when pending deployment is not found
export async function getLastDeploymentShaForApp(coolifyAppUuid: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT payload->>'_source_sha' as sha
     FROM jean_ci_webhook_events 
     WHERE event_type = 'coolify_deployment_started'
       AND payload->>'application_uuid' = $1
       AND payload->>'_source_sha' IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [coolifyAppUuid]
  );
  return result.rows[0]?.sha || null;
}

// Get SHA from coolify_deployment_started event by deployment_uuid
// This is the most reliable way to match a deployment_success to its source commit
export async function getShaForDeploymentUuid(deploymentUuid: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT payload->>'_source_sha' as sha
     FROM jean_ci_webhook_events 
     WHERE event_type = 'coolify_deployment_started'
       AND payload->>'deployment_uuid' = $1
     LIMIT 1`,
    [deploymentUuid]
  );
  return result.rows[0]?.sha || null;
}

// =============================================================================
// Coolify Task Events (Cron Jobs)
// =============================================================================

export interface TaskEvent {
  id: number;
  event_type: string;
  task_name: string | null;
  task_uuid: string | null;
  app_uuid: string | null;
  app_name: string | null;
  repo: string | null;
  status: 'success' | 'failure';
  output: string | null;
  url: string | null;
  created_at: Date;
}

export interface TaskSummary {
  task_name: string;
  app_uuid: string | null;
  app_name: string | null;
  repo: string | null;
  total_runs: number;
  success_count: number;
  failure_count: number;
  last_run: Date;
  last_status: 'success' | 'failure';
  last_output: string | null;
  url: string | null;
}

export interface TaskStats {
  total_tasks: number;
  total_runs: number;
  runs_24h: number;
  failures_24h: number;
}

// Get task events with optional filters
export async function getTaskEvents(options: {
  repo?: string;
  taskName?: string;
  limit?: number;
  offset?: number;
}): Promise<{ events: TaskEvent[]; total: number }> {
  const { repo, taskName, limit = 50, offset = 0 } = options;
  
  let whereClause = "WHERE e.event_type IN ('coolify_task_success', 'coolify_task_failed')";
  const params: any[] = [];
  let paramIndex = 1;
  
  if (repo) {
    whereClause += ` AND e.repo = $${paramIndex++}`;
    params.push(repo);
  }
  if (taskName) {
    whereClause += ` AND e.payload->>'task_name' = $${paramIndex++}`;
    params.push(taskName);
  }
  
  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) as count FROM jean_ci_webhook_events e ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);
  
  // Get events with app name from mapping table
  const result = await pool.query(
    `SELECT 
      e.id,
      e.event_type,
      e.payload->>'task_name' as task_name,
      e.payload->>'task_uuid' as task_uuid,
      e.payload->>'application_uuid' as app_uuid,
      COALESCE(m.coolify_app_name, e.payload->>'application_name') as app_name,
      e.repo,
      CASE WHEN e.event_type = 'coolify_task_success' THEN 'success' ELSE 'failure' END as status,
      e.payload->>'output' as output,
      e.payload->>'url' as url,
      e.created_at
    FROM jean_ci_webhook_events e
    LEFT JOIN jean_ci_app_mappings m ON e.payload->>'application_uuid' = m.coolify_app_uuid
    ${whereClause}
    ORDER BY e.created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...params, limit, offset]
  );
  
  return { events: result.rows, total };
}

// Get task summary (grouped by task name + app)
export async function getTaskSummary(repo?: string): Promise<TaskSummary[]> {
  let whereClause = "WHERE e.event_type IN ('coolify_task_success', 'coolify_task_failed')";
  const params: any[] = [];
  
  if (repo) {
    whereClause += ' AND e.repo = $1';
    params.push(repo);
  }
  
  const result = await pool.query(
    `WITH task_stats AS (
      SELECT 
        COALESCE(e.payload->>'task_name', 'Unknown') as task_name,
        e.payload->>'application_uuid' as app_uuid,
        COALESCE(m.coolify_app_name, e.payload->>'application_name', e.payload->>'_app_name') as app_name,
        e.repo,
        COUNT(*) as total_runs,
        SUM(CASE WHEN e.event_type = 'coolify_task_success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN e.event_type = 'coolify_task_failed' THEN 1 ELSE 0 END) as failure_count,
        MAX(e.created_at) as last_run
      FROM jean_ci_webhook_events e
      LEFT JOIN jean_ci_app_mappings m ON e.payload->>'application_uuid' = m.coolify_app_uuid
      ${whereClause}
      GROUP BY task_name, app_uuid, app_name, e.repo
    ),
    last_events AS (
      SELECT DISTINCT ON (COALESCE(e.payload->>'task_name', 'Unknown'), e.payload->>'application_uuid')
        COALESCE(e.payload->>'task_name', 'Unknown') as task_name,
        e.payload->>'application_uuid' as app_uuid,
        e.event_type,
        e.payload->>'output' as output,
        e.payload->>'url' as url
      FROM jean_ci_webhook_events e
      ${whereClause}
      ORDER BY COALESCE(e.payload->>'task_name', 'Unknown'), e.payload->>'application_uuid', e.created_at DESC
    )
    SELECT 
      ts.task_name,
      ts.app_uuid,
      ts.app_name,
      ts.repo,
      ts.total_runs,
      ts.success_count,
      ts.failure_count,
      ts.last_run,
      CASE WHEN le.event_type = 'coolify_task_success' THEN 'success' ELSE 'failure' END as last_status,
      le.output as last_output,
      le.url
    FROM task_stats ts
    LEFT JOIN last_events le ON ts.task_name = le.task_name AND ts.app_uuid = le.app_uuid
    ORDER BY ts.last_run DESC`,
    params
  );
  
  return result.rows;
}

// Get task stats
export async function getTaskStats(): Promise<TaskStats> {
  const result = await pool.query(`
    SELECT 
      COUNT(DISTINCT COALESCE(payload->>'task_name', 'Unknown') || ':' || COALESCE(payload->>'application_uuid', '')) as total_tasks,
      COUNT(*) as total_runs,
      SUM(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as runs_24h,
      SUM(CASE WHEN created_at > NOW() - INTERVAL '24 hours' AND event_type = 'coolify_task_failed' THEN 1 ELSE 0 END) as failures_24h
    FROM jean_ci_webhook_events
    WHERE event_type IN ('coolify_task_success', 'coolify_task_failed')
  `);
  
  return {
    total_tasks: parseInt(result.rows[0].total_tasks || '0', 10),
    total_runs: parseInt(result.rows[0].total_runs || '0', 10),
    runs_24h: parseInt(result.rows[0].runs_24h || '0', 10),
    failures_24h: parseInt(result.rows[0].failures_24h || '0', 10),
  };
}
