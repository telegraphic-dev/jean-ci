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
export const MAX_EVENTS = 1000;

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

export async function insertEvent(eventType: string, deliveryId: string, repo: string | null, action: string | null, payload: any) {
  try {
    await pool.query(`
      INSERT INTO jean_ci_webhook_events (event_type, delivery_id, repo, action, payload)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventType, deliveryId, repo, action, JSON.stringify(payload)]);
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
  const result = await sql`
    SELECT * FROM check_runs 
    WHERE repo = ${repo}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return result.rows as CheckRun[];
}

export async function getDeploymentsByRepo(repo: string, limit = 20): Promise<any[]> {
  const result = await sql`
    SELECT * FROM webhook_events 
    WHERE repo = ${repo} 
    AND (event_type = 'deployment_status' OR event_type = 'registry_package')
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return result.rows;
}
