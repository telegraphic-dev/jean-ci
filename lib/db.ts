import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { approvalPrompts, observedApproval, approvalDeadline, terminalDiagnostic, terminalRun } from './hermes-runs.ts';
import type { RunBinding, RunStore, HermesRun, ApprovalPrompt } from './hermes-runs.ts';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: DATABASE_URL });

// System prompt (fixed)
export { SYSTEM_PROMPT } from './review-request.ts';

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

      CREATE TABLE IF NOT EXISTS jean_ci_api_tokens (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        token_prefix TEXT NOT NULL,
        last_used_at TIMESTAMP,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_api_tokens_revoked ON jean_ci_api_tokens(revoked_at);

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
        manually_overridden BOOLEAN DEFAULT FALSE,
        override_reason TEXT,
        overridden_by TEXT,
        overridden_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_review_runs (
        check_id INTEGER NOT NULL REFERENCES jean_ci_check_runs(id) ON DELETE CASCADE,
        segment INTEGER NOT NULL,
        request_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        scope TEXT NOT NULL,
        run_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'submitting',
        pending JSONB NOT NULL DEFAULT '[]',
        denied BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (check_id, segment)
      );
      ALTER TABLE jean_ci_review_runs ADD COLUMN IF NOT EXISTS diagnostic JSONB;
      ALTER TABLE jean_ci_review_runs ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS jean_ci_review_restarts (
        source_check_id INTEGER PRIMARY KEY REFERENCES jean_ci_check_runs(id),
        new_check_id INTEGER NOT NULL UNIQUE REFERENCES jean_ci_check_runs(id),
        actor TEXT NOT NULL,
        dispatch_status TEXT NOT NULL DEFAULT 'queued',
        dispatch_started_at TIMESTAMPTZ,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE jean_ci_review_restarts ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;
      ALTER TABLE jean_ci_review_restarts ADD COLUMN IF NOT EXISTS dispatch_fenced BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE jean_ci_check_runs ADD COLUMN IF NOT EXISTS check_identity TEXT;
      -- Public check completion outbox, separate from authenticated diagnostics.
      ALTER TABLE jean_ci_check_runs ADD COLUMN IF NOT EXISTS github_completion JSONB;
      CREATE TABLE IF NOT EXISTS jean_ci_review_approval_comments (
        check_id INTEGER NOT NULL REFERENCES jean_ci_check_runs(id) ON DELETE CASCADE,
        identity TEXT NOT NULL,
        marker TEXT NOT NULL,
        lease TEXT NOT NULL,
        lease_until TIMESTAMP NOT NULL,
        uncertain BOOLEAN NOT NULL DEFAULT FALSE,
        candidate_id BIGINT,
        comment_id BIGINT,
        comment_url TEXT,
        PRIMARY KEY (check_id, identity)
      );
      CREATE TABLE IF NOT EXISTS jean_ci_review_notifications (
        check_id INTEGER NOT NULL REFERENCES jean_ci_check_runs(id) ON DELETE CASCADE,
        identity TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (check_id, identity)
      );
      CREATE TABLE IF NOT EXISTS jean_ci_review_decisions (
        check_id INTEGER NOT NULL,
        segment INTEGER NOT NULL,
        prompt_id TEXT NOT NULL,
        generation BIGINT NOT NULL,
        choice TEXT NOT NULL,
        actor TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'dispatching',
        notified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (check_id, segment, prompt_id, generation),
        FOREIGN KEY (check_id, segment) REFERENCES jean_ci_review_runs(check_id, segment) ON DELETE CASCADE
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

      CREATE TABLE IF NOT EXISTS jean_ci_openclaw_device_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_tasks (
        task_id TEXT PRIMARY KEY,
        owner_subject TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'working',
        status_message TEXT,
        input_requests JSONB,
        result JSONB,
        error JSONB,
        metadata JSONB NOT NULL DEFAULT '{}',
        ttl_ms INTEGER,
        poll_interval_ms INTEGER NOT NULL DEFAULT 2500,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_tasks_expires ON jean_ci_mcp_tasks(expires_at);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        client_name TEXT NOT NULL,
        redirect_uris JSONB NOT NULL,
        grant_types JSONB NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        scope TEXT NOT NULL DEFAULT 'mcp:read mcp:write',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_oauth_pending (
        request_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL DEFAULT 'S256',
        resource TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_oauth_pending_expires ON jean_ci_mcp_oauth_pending(expires_at);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_oauth_codes_expires ON jean_ci_mcp_oauth_codes(expires_at);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_type TEXT NOT NULL,
        family_id TEXT NOT NULL,
        source_code_hash TEXT,
        client_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        revoked_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_oauth_tokens_family ON jean_ci_mcp_oauth_tokens(family_id);
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_oauth_tokens_code ON jean_ci_mcp_oauth_tokens(source_code_hash);
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_oauth_tokens_expires ON jean_ci_mcp_oauth_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_events (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo TEXT,
        pr_number INTEGER,
        conclusion TEXT,
        check_name TEXT,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_events_name_id ON jean_ci_mcp_events(name, id);
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_events_created_at ON jean_ci_mcp_events(created_at);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_event_subscriptions (
        subscription_key_hash TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL UNIQUE,
        principal TEXT NOT NULL,
        oauth_token_family_id TEXT,
        event_name TEXT NOT NULL,
        arguments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        callback_url TEXT NOT NULL,
        secret TEXT NOT NULL,
        previous_secret TEXT,
        previous_secret_expires_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        last_cursor_id BIGINT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_delivery_at TIMESTAMPTZ,
        last_error TEXT,
        failed_since TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_event_subs_event_active ON jean_ci_mcp_event_subscriptions(event_name, active, expires_at);
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_event_subs_principal ON jean_ci_mcp_event_subscriptions(principal);

      CREATE TABLE IF NOT EXISTS jean_ci_mcp_event_verified_endpoints (
        principal TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (principal, callback_url)
      );
      CREATE INDEX IF NOT EXISTS idx_jean_ci_mcp_event_verified_expires ON jean_ci_mcp_event_verified_endpoints(expires_at);
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

export interface ApiTokenRecord {
  id: number;
  name: string;
  token_prefix: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export async function createApiToken(name: string, tokenHash: string, tokenPrefix: string): Promise<ApiTokenRecord> {
  const result = await pool.query(
    `INSERT INTO jean_ci_api_tokens (name, token_hash, token_prefix)
     VALUES ($1, $2, $3)
     RETURNING id, name, token_prefix, last_used_at, revoked_at, created_at`,
    [name, tokenHash, tokenPrefix]
  );
  return result.rows[0];
}

export async function listApiTokens(): Promise<ApiTokenRecord[]> {
  const result = await pool.query(
    `SELECT id, name, token_prefix, last_used_at, revoked_at, created_at
     FROM jean_ci_api_tokens
     ORDER BY created_at DESC`
  );
  return result.rows;
}

export async function revokeApiToken(id: number): Promise<ApiTokenRecord | null> {
  const result = await pool.query(
    `UPDATE jean_ci_api_tokens
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
     WHERE id = $1
     RETURNING id, name, token_prefix, last_used_at, revoked_at, created_at`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getActiveApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
  const result = await pool.query(
    `SELECT id, name, token_prefix, last_used_at, revoked_at, created_at
     FROM jean_ci_api_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

export async function touchApiTokenLastUsed(id: number): Promise<void> {
  await pool.query(
    `UPDATE jean_ci_api_tokens
     SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );
}

export async function getJsonState<T>(key: string): Promise<T | null> {
  const result = await pool.query(
    `SELECT value
     FROM jean_ci_openclaw_device_state
     WHERE key = $1`,
    [key],
  );
  return (result.rows[0]?.value as T | undefined) ?? null;
}

export async function setJsonState(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO jean_ci_openclaw_device_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value)],
  );
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
  const result = await pool.query(
    'SELECT id, full_name, installation_id, pr_review_enabled, created_at, updated_at FROM jean_ci_repos WHERE full_name = $1',
    [fullName],
  );
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
  const result = await pool.query(
    'SELECT id, full_name, installation_id, pr_review_enabled, created_at, updated_at FROM jean_ci_repos ORDER BY full_name',
  );
  return result.rows;
}

// Check run helpers
export const reviewRunStore: RunStore = {
  async reserve(check, segment, scope, fingerprint) {
    await pool.query(`INSERT INTO jean_ci_review_runs (check_id, segment, scope, fingerprint, request_key)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (check_id, segment) DO NOTHING`,
    [check, segment, scope, fingerprint, `jean-review-${randomUUID()}`]);
    const result = await pool.query('SELECT * FROM jean_ci_review_runs WHERE check_id=$1 AND segment=$2', [check, segment]);
    const row = result.rows[0];
    if (!row || row.scope !== scope || row.fingerprint !== fingerprint) throw new Error('Review run requester or payload changed; cannot resubmit.');
    return row;
  },
  async bind(check, segment, run) {
    const result = await pool.query(`UPDATE jean_ci_review_runs SET run_id=$3 WHERE check_id=$1 AND segment=$2
      AND (run_id IS NULL OR run_id=$3) RETURNING run_id`, [check, segment, run]);
    if (!result.rowCount) throw new Error('Review run identity conflict');
  },
  async get(check) {
    const rows = (await pool.query(`SELECT r.*, (r.denied OR EXISTS (
      SELECT 1 FROM jean_ci_review_decisions d WHERE d.check_id=r.check_id AND d.segment=r.segment
      AND (d.choice='deny' OR d.outcome NOT IN ('accepted', 'dispatching') OR
        (d.outcome='dispatching' AND (d.created_at IS NULL OR d.created_at <= NOW()-INTERVAL '60 seconds'))))) AS denied,
      EXISTS (SELECT 1 FROM jean_ci_review_decisions d WHERE d.check_id=r.check_id AND d.segment=r.segment
        AND d.choice='once' AND d.outcome='dispatching' AND d.created_at > NOW()-INTERVAL '60 seconds') AS settling
      FROM jean_ci_review_runs r WHERE r.check_id=$1 ORDER BY r.segment`, [check])).rows;
    const decisions = (await pool.query(`SELECT *, created_at > NOW()-INTERVAL '60 seconds' AS leased FROM jean_ci_review_decisions WHERE check_id=$1`, [check])).rows;
    return rows.map(row => ({ ...row, history: (row.history || []).map((h: import('./hermes-runs.ts').ApprovalHistory) => {
      const d = decisions.find(d => d.segment === row.segment && d.prompt_id === h.prompt_id && Number(d.generation) === h.execution_generation);
      if (!d) return h;
      return { ...h, outcome: d.choice === 'deny' ? 'denied' : d.outcome === 'accepted' ? 'approved' : d.outcome === 'dispatching' && d.leased ? 'pending' : 'unconfirmed' };
    }) }));
  },
  async observe(binding, fetchRun) {
    // Serialize observations so concurrent page/runner polls cannot erase a
    // decision or miss a native expiry. No commands enter public check summaries.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM jean_ci_review_runs WHERE check_id=$1 AND segment=$2 FOR UPDATE', [binding.check_id, binding.segment])).rows[0];
      if (!row || row.run_id !== binding.run_id || row.scope !== binding.scope) throw new Error('Review run identity conflict');
      // Cross-process lock covers the fetch as well as the write. No client clock
      // or pre-lock snapshot may erase a newer native approval.
      const run = await fetchRun();
      if (row.run_id !== run.run_id) throw new Error('Review run identity conflict');
      const history: import('./hermes-runs.ts').ApprovalHistory[] = row.history || [];
      const pending = approvalPrompts(run).map(prompt => {
        const prior = (row.pending as ApprovalPrompt[]).find(p => p.prompt_id === prompt.prompt_id && p.execution_generation === prompt.execution_generation);
        const recorded = history.find(h => h.prompt_id === prompt.prompt_id && h.execution_generation === prompt.execution_generation);
        // Re-observation, including after process restart or a settled projection,
        // cannot mint a new window for an old exact native identity.
        const saved = recorded?.expiresAt ? { ...prompt, first_observed_at: recorded.firstObservedAt ?? Date.parse(recorded.expiresAt) / 1000 - 1800, app_deadline_at: Date.parse(recorded.expiresAt) / 1000 } : undefined;
        return observedApproval(prompt, prior?.app_deadline_at != null ? prior : saved);
      });
      run.pending_controls = pending;
      for (const prompt of [...pending, ...row.pending] as ApprovalPrompt[]) {
        if (!history.some(h => h.prompt_id === prompt.prompt_id && h.execution_generation === prompt.execution_generation)) history.push({
          prompt_id: prompt.prompt_id, execution_generation: prompt.execution_generation, outcome: 'pending',
          expiresAt: approvalDeadline(prompt) ? new Date(approvalDeadline(prompt)! * 1000).toISOString() : null,
          deadlineApproximate: prompt.deadline_approximate, firstObservedAt: prompt.first_observed_at,
        });
      }
      let denied = row.denied;
      for (const previous of row.pending as ApprovalPrompt[]) {
        if (pending.some(p => p.prompt_id === previous.prompt_id && p.execution_generation === previous.execution_generation)) continue;
        const decision = (await client.query(`SELECT choice, outcome FROM jean_ci_review_decisions
          WHERE check_id=$1 AND segment=$2 AND prompt_id=$3 AND generation=$4`,
        [binding.check_id, binding.segment, previous.prompt_id, previous.execution_generation])).rows[0];
        if (!decision || decision.choice === 'deny' || decision.outcome === 'uncertain') denied = true;
        const h = history.find(h => h.prompt_id === previous.prompt_id && h.execution_generation === previous.execution_generation)!;
        h.outcome = !decision ? (approvalDeadline(previous) && approvalDeadline(previous)! * 1000 <= Date.now() ? 'expired' : 'unconfirmed') : decision.choice === 'deny' ? 'denied' : decision.outcome === 'accepted' ? 'approved' : 'unconfirmed';
      }
      // Save terminal evidence before the worker's fail-closed denial check.
      // Never persist the native envelope (which can contain private tool data).
      const diagnostic = terminalDiagnostic(run);
      await client.query(`UPDATE jean_ci_review_runs SET status=$3,pending=$4::jsonb,denied=$5,history=$6::jsonb,diagnostic=CASE WHEN diagnostic->>'output' IS NOT NULL THEN diagnostic ELSE COALESCE($7::jsonb,diagnostic) END WHERE check_id=$1 AND segment=$2`,
      [binding.check_id, binding.segment, run.status, JSON.stringify(pending), denied, JSON.stringify(history), diagnostic ? JSON.stringify(diagnostic) : null]);
      await client.query('COMMIT');
      return run;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  },
};

export async function claimReviewDecision(binding: RunBinding, prompt: ApprovalPrompt, choice: 'once' | 'deny', actor: string): Promise<boolean> {
  const result = await pool.query(`INSERT INTO jean_ci_review_decisions (check_id,segment,prompt_id,generation,choice,actor)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING prompt_id`,
  [binding.check_id, binding.segment, prompt.prompt_id, prompt.execution_generation, choice, actor]);
  return !!result.rowCount;
}
export async function finishReviewDecision(binding: RunBinding, prompt: ApprovalPrompt, outcome: 'accepted' | 'uncertain', choice: 'once' | 'deny') {
  const result = await pool.query(`UPDATE jean_ci_review_decisions
    SET outcome=CASE WHEN outcome='uncertain' OR created_at IS NULL OR created_at <= NOW()-INTERVAL '60 seconds' THEN 'uncertain' ELSE $5 END
    WHERE check_id=$1 AND segment=$2 AND prompt_id=$3 AND generation=$4 RETURNING outcome`,
  [binding.check_id, binding.segment, prompt.prompt_id, prompt.execution_generation, outcome]);
  if (outcome === 'accepted' && result.rows[0]?.outcome !== 'accepted') throw new Error('Decision dispatch lease expired');
  if (choice === 'deny' || outcome === 'uncertain') await pool.query('UPDATE jean_ci_review_runs SET denied=TRUE WHERE check_id=$1 AND segment=$2', [binding.check_id, binding.segment]);
}
export interface ApprovalCommentClaim { check_id: number; identity: string; marker: string; lease: string; uncertain: boolean; candidate_id: string | null; }
export async function claimApprovalComment(check: number, identity: string): Promise<ApprovalCommentClaim | null> {
  const result = await pool.query(`INSERT INTO jean_ci_review_approval_comments(check_id,identity,marker,lease,lease_until)
    VALUES ($1,$2,$3,$4,NOW()+INTERVAL '30 seconds') ON CONFLICT (check_id,identity) DO UPDATE
    SET lease=EXCLUDED.lease,lease_until=EXCLUDED.lease_until
    WHERE jean_ci_review_approval_comments.comment_id IS NULL AND jean_ci_review_approval_comments.lease_until<NOW()
    RETURNING *`, [check, identity, randomUUID(), randomUUID()]);
  return result.rows[0] || null;
}
export async function updateApprovalComment(claim: ApprovalCommentClaim, data: { uncertain?: boolean; candidateId?: number; commentId?: number; url?: string }) {
  await pool.query(`UPDATE jean_ci_review_approval_comments SET uncertain=COALESCE($4,uncertain),
    candidate_id=COALESCE($5,candidate_id),comment_id=COALESCE($6,comment_id),comment_url=COALESCE($7,comment_url)
    WHERE check_id=$1 AND identity=$2 AND lease=$3`,
  [claim.check_id, claim.identity, claim.lease, data.uncertain, data.candidateId, data.commentId, data.url]);
}

export async function claimReviewNotification(check: number, identity: string): Promise<boolean> {
  const result = await pool.query(`INSERT INTO jean_ci_review_notifications(check_id,identity) VALUES ($1,$2)
    ON CONFLICT DO NOTHING RETURNING check_id`, [check, identity]);
  return !!result.rowCount;
}

// Source-row locking and a unique durable mapping deduplicate cross-process clicks.
export async function reserveReviewRestart(id: number, actor: string, validate: (check: CheckRun) => Promise<void>) {
  const receiptClient = await pool.connect();
  try {
    await receiptClient.query('BEGIN');
    await receiptClient.query('SELECT id FROM jean_ci_check_runs WHERE id=$1 FOR UPDATE', [id]);
    const receipt = (await receiptClient.query('SELECT new_check_id FROM jean_ci_review_restarts WHERE source_check_id=$1', [id])).rows[0];
    await receiptClient.query('COMMIT');
    if (receipt) return Number(receipt.new_check_id);
  } catch (error) { await receiptClient.query('ROLLBACK'); throw error; } finally { receiptClient.release(); }
  const validated = await getCheckRun(id);
  if (!validated) throw new Error('Check not found');
  // No pool connection is held while validation queries the run store and GitHub.
  await validate(validated);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = (await client.query('SELECT * FROM jean_ci_check_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!check) throw new Error('Check not found');
    let row = (await client.query('SELECT new_check_id FROM jean_ci_review_restarts WHERE source_check_id=$1', [id])).rows[0];
    if (!row) {
      if (check.status !== 'completed' || check.repo !== validated.repo || check.pr_number !== validated.pr_number || check.head_sha !== validated.head_sha || check.check_name !== validated.check_name || check.check_identity !== validated.check_identity) throw new Error('Source check changed');
      const created = await client.query(`INSERT INTO jean_ci_check_runs(repo,pr_number,check_name,head_sha,status,check_identity)
        VALUES($1,$2,$3,$4,'queued',$5) RETURNING id`, [check.repo, check.pr_number, check.check_name, check.head_sha, check.check_identity]);
      row = { new_check_id: created.rows[0].id };
      await client.query('INSERT INTO jean_ci_review_restarts(source_check_id,new_check_id,actor) VALUES($1,$2,$3)', [id, row.new_check_id, actor]);
    }
    await client.query('COMMIT');
    return Number(row.new_check_id);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
// Dedicated sessions fence dispatch across actual app instances, including long
// approval waits. PostgreSQL releases ownership on connection/process death.
const restartOwners = new Map<number, pg.Client>();
const RESTART_LOCK_NAMESPACE = 165;
export async function assertReviewRestartOwner(sourceId: number) {
  const client = restartOwners.get(sourceId);
  if (!client) throw new Error('Review restart owner lost');
  // The dedicated session is never returned to a pool or reconnected. A failed
  // probe fences late publication after PostgreSQL has released its lock.
  await client.query('SELECT 1');
}
// Persist on the lock-owning session, never the general pool. Connection loss
// aborts this statement before recovery can acquire ownership; the active-claim
// and unfinished-check guards also refuse writes after settlement. A separate
// liveness probe (even after GitHub returns) cannot fence a later pooled UPDATE.
export async function updateReviewRestartCheck(sourceId: number, id: number, data: Parameters<typeof updateCheckRun>[1]) {
  const client = restartOwners.get(sourceId);
  if (!client) throw new Error('Review restart owner lost');
  const result = await client.query(`UPDATE jean_ci_check_runs c SET
    status=COALESCE($3,c.status), conclusion=COALESCE($4,c.conclusion),
    title=COALESCE($5,c.title), summary=COALESCE($6,c.summary),
    completed_at=COALESCE($7,c.completed_at),
    github_completion=CASE WHEN $8 THEN $9::jsonb ELSE c.github_completion END
    WHERE c.id=$2 AND c.status IN ('queued','in_progress') AND EXISTS (
      SELECT 1 FROM jean_ci_review_restarts r WHERE r.source_check_id=$1
      AND r.new_check_id=c.id AND r.dispatch_status='dispatching' AND r.dispatch_fenced
    ) RETURNING c.id`, [sourceId, id, data.status, data.conclusion, data.title, data.summary, data.completed_at,
      data.github_completion !== undefined, data.github_completion == null ? null : JSON.stringify(data.github_completion)]);
  if (!result.rowCount) throw new Error('Review restart owner lost or check already settled');
}
export async function claimReviewRestart(sourceId: number): Promise<CheckRun | null> {
  // Do not occupy the query pool for the whole approval wait (pool starvation
  // would otherwise prevent status/decision queries from completing).
  const client = new pg.Client({ connectionString: DATABASE_URL, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  client.on('error', () => {});
  let owned = false;
  try {
    await client.connect();
    owned = (await client.query('SELECT pg_try_advisory_lock($1,$2) AS owned', [RESTART_LOCK_NAMESPACE, sourceId])).rows[0].owned;
    if (!owned) return null;
    const result = await client.query(`WITH claimed AS (
      UPDATE jean_ci_review_restarts SET dispatch_status='dispatching',dispatch_started_at=NOW(),dispatch_fenced=TRUE
      WHERE source_check_id=$1 AND dispatch_status='queued' RETURNING new_check_id
    ) SELECT c.* FROM jean_ci_check_runs c JOIN claimed r ON r.new_check_id=c.id`, [sourceId]);
    if (!result.rows[0]) return null;
    restartOwners.set(sourceId, client);
    return result.rows[0];
  } finally {
    if (restartOwners.get(sourceId) !== client) {
      try { if (owned) await client.query('SELECT pg_advisory_unlock($1,$2)', [RESTART_LOCK_NAMESPACE, sourceId]); }
      finally { await client.end(); }
    }
  }
}

// Local terminalization and queue settlement are one transaction, even before a
// GitHub ID exists. Never replay a claimed request: external writes may have
// succeeded without an acknowledgement. Keep the source mapping for deduplication.
export async function finishReviewRestart(sourceId: number) {
  const client = restartOwners.get(sourceId);
  if (!client) return;
  try { await settleReviewRestarts(sourceId, client); }
  finally {
    restartOwners.delete(sourceId);
    try { await client.query('SELECT pg_advisory_unlock($1,$2)', [RESTART_LOCK_NAMESPACE, sourceId]); }
    finally { await client.end(); }
  }
}
export async function reconcileReviewRestarts(_startedBefore?: Date) {
  // Legacy processes never took this lock: absence cannot prove their death.
  // Preserve those uncertain claims for operator inspection, never replay them.
  const candidates = (await pool.query("SELECT source_check_id FROM jean_ci_review_restarts WHERE dispatch_status='dispatching' AND dispatch_fenced")).rows;
  for (const row of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owned = (await client.query('SELECT pg_try_advisory_xact_lock($1,$2) AS owned', [RESTART_LOCK_NAMESPACE, row.source_check_id])).rows[0].owned;
      if (owned) await settleReviewRestarts(row.source_check_id, client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
async function settleReviewRestarts(sourceId: number, client: pg.Client | pg.PoolClient) {
  await client.query(`WITH settled AS (
    UPDATE jean_ci_review_restarts SET dispatch_status='done'
    WHERE dispatch_status='dispatching' AND source_check_id=$1
    RETURNING new_check_id
  ) UPDATE jean_ci_check_runs c SET status='completed',conclusion='failure',
    title='Review restart interrupted',
    summary='INCOMPLETE: The explicit restart could not finish. No approval was granted and no execution was automatically retried. External effects may have occurred; their outcome is not assumed.',
    completed_at=NOW()
    FROM settled r WHERE c.id=r.new_check_id AND c.status IN ('queued','in_progress')`, [sourceId]);
}
export async function queuedReviewRestarts(): Promise<number[]> {
  return (await pool.query(`SELECT source_check_id FROM jean_ci_review_restarts WHERE dispatch_status='queued'`)).rows.map(r => r.source_check_id);
}

export interface CheckRun {
  github_completion?: Record<string, any> | null;
  check_identity?: string;
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
  manually_overridden?: boolean;
  override_reason?: string;
  overridden_by?: string;
  overridden_at?: Date;
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
  check_identity?: string;
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
    (github_check_id, repo, pr_number, check_name, head_sha, status, prompt, pr_title, pr_body, diff_preview, check_identity)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [data.github_check_id, data.repo, data.pr_number, data.check_name, data.head_sha, 
      'queued', data.prompt, data.pr_title, data.pr_body, data.diff_preview, data.check_identity]);
  return result.rows[0].id;
}

export async function updateCheckRun(id: number, data: {
  github_completion?: Record<string, any> | null;
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
      completed_at = COALESCE($6, completed_at),
      github_completion = CASE WHEN $7 THEN $8::jsonb ELSE github_completion END
    WHERE id = $1
  `, [id, data.status, data.conclusion, data.title, data.summary, data.completed_at,
      data.github_completion !== undefined, data.github_completion == null ? null : JSON.stringify(data.github_completion)]);
}

export async function setReservedCheckInput(id: number, head: string, data: { prompt: string; pr_title: string; pr_body: string; diff_preview: string }) {
  const result = await pool.query(`UPDATE jean_ci_check_runs SET prompt=$3,pr_title=$4,pr_body=$5,diff_preview=$6
    WHERE id=$1 AND head_sha=$2 AND status='queued' RETURNING id`, [id, head, data.prompt, data.pr_title, data.pr_body, data.diff_preview]);
  if (!result.rowCount) throw new Error('Reserved review check changed or completed');
}

export async function setCheckRunGithubId(id: number, githubCheckId: number) {
  await pool.query('UPDATE jean_ci_check_runs SET github_check_id = $1 WHERE id = $2', [githubCheckId, id]);
}

export async function getCheckRun(id: number): Promise<CheckRun | null> {
  const result = await pool.query('SELECT * FROM jean_ci_check_runs WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getInterruptedCheckRuns(startedBefore: Date): Promise<CheckRun[]> {
  const result = await pool.query(
    `SELECT * FROM jean_ci_check_runs
     WHERE ((status IN ('queued', 'in_progress') AND created_at < $1)
       OR (status = 'completed' AND github_completion IS NOT NULL))
       AND github_check_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jean_ci_review_restarts r WHERE r.new_check_id=jean_ci_check_runs.id
         AND r.dispatch_status IN ('queued','dispatching'))
     ORDER BY created_at ASC`,
    [startedBefore],
  );
  return result.rows;
}

export async function getLatestCheckRunIdByGithubCheckId(githubCheckId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM jean_ci_check_runs
     WHERE github_check_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [githubCheckId]
  );
  return result.rows[0]?.id ?? null;
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

export async function overrideCheckRunToPass(id: number, reason: string, overriddenBy: string): Promise<CheckRun | null> {
  const sanitizedReason = reason.trim();
  if (!sanitizedReason) {
    throw new Error('Override reason is required');
  }

  const result = await pool.query(
    `UPDATE jean_ci_check_runs
     SET summary = CONCAT(
           COALESCE(summary, ''),
           CASE WHEN COALESCE(summary, '') = '' THEN '' ELSE E'\n\n---\n\n' END,
           'Manual override recorded by ', $3::text, '.\n\nReason: ', $2::text,
           '\n\nGitHub check/review state was not changed automatically.'
         ),
         manually_overridden = TRUE,
         override_reason = $2::text,
         overridden_by = $3::text,
         overridden_at = CURRENT_TIMESTAMP,
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
     WHERE id = $1
       AND status = 'completed'
       AND conclusion = 'failure'
       AND COALESCE(manually_overridden, FALSE) = FALSE
     RETURNING *`,
    [id, sanitizedReason, overriddenBy]
  );

  return result.rows[0] || null;
}

export interface PublicCheckRun {
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
  manually_overridden?: boolean;
  override_reason?: string;
  overridden_by?: string;
  overridden_at?: Date;
  created_at: Date;
  completed_at?: Date;
}

export async function getPublicCheckRunsPaginated(
  page = 1,
  limit = 50,
  repo?: string
): Promise<PaginatedResult<PublicCheckRun>> {
  const offset = (page - 1) * limit;

  const whereClause = repo ? 'WHERE repo = $1' : '';
  const pageParams = repo ? [repo, limit, offset] : [limit, offset];
  const countParams = repo ? [repo] : [];

  const [items, countResult] = await Promise.all([
    pool.query(
      `SELECT id, github_check_id, repo, pr_number, check_name, head_sha, status, conclusion, title, summary, created_at, completed_at
       FROM jean_ci_check_runs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${repo ? 2 : 1} OFFSET $${repo ? 3 : 2}`,
      pageParams
    ),
    pool.query(`SELECT COUNT(*) FROM jean_ci_check_runs ${whereClause}`, countParams)
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getRecentEventsPaginated(
  page = 1,
  limit = 50,
  eventType?: string,
  repo?: string
): Promise<PaginatedResult<WebhookEvent>> {
  const offset = (page - 1) * limit;
  
  let query = `SELECT id, event_type, delivery_id, repo, action, processed, source, created_at 
               FROM jean_ci_webhook_events`;
  let countQuery = 'SELECT COUNT(*) FROM jean_ci_webhook_events';
  const params: any[] = [];
  const whereClauses: string[] = [];
  if (eventType) {
    whereClauses.push(`event_type = $${whereClauses.length + 1}`);
    params.push(eventType);
  }
  if (repo) {
    whereClauses.push(`repo = $${whereClauses.length + 1}`);
    params.push(repo);
  }

  if (whereClauses.length > 0) {
    const where = whereClauses.join(' AND ');
    query += ` WHERE ${where}`;
    countQuery += ` WHERE ${where}`;
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  
  const [items, countResult] = await Promise.all([
    pool.query(query, params),
    pool.query(countQuery, params.slice(0, params.length - 2))
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
    SELECT r.id, r.full_name, r.installation_id, r.pr_review_enabled, r.created_at, r.updated_at,
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

export async function deletePendingDeployment(appUuid: string, deploymentUuid?: string): Promise<void> {
  await pool.query(
    'DELETE FROM jean_ci_pending_deployments WHERE app_uuid = $1 AND ($2::text IS NULL OR coolify_deployment_uuid = $2)',
    [appUuid, deploymentUuid ?? null],
  );
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
  // Format: {dashboard}/project/{projectUuid}/{environmentName}/application/{appUuid}
  if (logsUrl) {
    const match = logsUrl.match(/\/project\/([^/]+)\/([^/]+)\/application\/[^/]+$/);
    if (match) {
      return `${logsUrl.split('/project/')[0]}/project/${match[1]}/${match[2]}/application/${appUuid}/deployment/${deploymentUuid}`;
    }
  }
  // Fallback - just link to the deployment directly when a dashboard URL is configured
  const coolifyUrl = process.env.COOLIFY_DASHBOARD_URL || process.env.COOLIFY_URL || '';
  return coolifyUrl ? `${coolifyUrl}/deployments/${deploymentUuid}` : deploymentUuid;
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
  latestReviewId: number | null;
  latestReviewIsCurrent: boolean;
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
      ORDER BY repo, (payload->>'number')::int, created_at DESC, id DESC
    )
    SELECT events.*, review.id AS latest_review_id, review.head_sha AS latest_review_head_sha,
      latest_check.status AS check_status, latest_check.conclusion AS check_conclusion
    FROM latest_pr_events events
    LEFT JOIN LATERAL (
      SELECT id, head_sha FROM jean_ci_check_runs
      WHERE repo = events.repo AND pr_number = events.pr_number AND check_name = 'Code Review'
      ORDER BY (head_sha = NULLIF(COALESCE(events.payload->'pull_request'->'head'->>'sha', events.payload->'head'->>'sha'), '')) DESC NULLS LAST,
        created_at DESC, id DESC
      LIMIT 1
    ) review ON TRUE
    LEFT JOIN LATERAL (
      SELECT status, conclusion FROM jean_ci_check_runs
      WHERE repo = events.repo AND pr_number = events.pr_number
        AND head_sha = NULLIF(COALESCE(events.payload->'pull_request'->'head'->>'sha', events.payload->'head'->>'sha'), '')
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) latest_check ON TRUE
    WHERE events.payload->>'action' != 'closed'
    ORDER BY events.created_at DESC, events.repo, events.pr_number
  `);

  const prs: OpenPR[] = [];
  
  for (const row of result.rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const pr = payload.pull_request || payload;
    
    let checkStatus: 'pending' | 'success' | 'failure' = 'pending';
    if (row.check_status === 'completed') {
      checkStatus = row.check_conclusion === 'success' ? 'success' : 'failure';
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
      latestReviewId: row.latest_review_id ?? null,
      latestReviewIsCurrent: Boolean(pr.head?.sha && row.latest_review_head_sha === pr.head.sha),
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

export interface CheckRunFilterOptions {
  repo?: string;
  prNumber?: number;
  status?: string;
  conclusion?: string;
  checkName?: string;
  headSha?: string;
  page?: number;
  limit?: number;
}

export interface CheckRunSummaryRecord extends PublicCheckRun {
  check_identity?: string;
  pr_title?: string;
}

export async function getCheckRunsFiltered(
  options: CheckRunFilterOptions = {}
): Promise<PaginatedResult<CheckRunSummaryRecord>> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const offset = (page - 1) * limit;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (options.repo) {
    params.push(options.repo);
    whereClauses.push(`repo = $${params.length}`);
  }
  if (options.prNumber !== undefined) {
    params.push(options.prNumber);
    whereClauses.push(`pr_number = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    whereClauses.push(`status = $${params.length}`);
  }
  if (options.conclusion) {
    params.push(options.conclusion);
    whereClauses.push(`conclusion = $${params.length}`);
  }
  if (options.checkName) {
    params.push(options.checkName);
    whereClauses.push(`LOWER(check_name) = LOWER($${params.length})`);
  }
  if (options.headSha) {
    params.push(`${options.headSha}%`);
    whereClauses.push(`head_sha LIKE $${params.length}`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const pageParams = [...params, limit, offset];

  const [items, countResult] = await Promise.all([
    pool.query(
      `SELECT id, github_check_id, repo, pr_number, check_name, check_identity, head_sha,
              status, conclusion, title, summary, pr_title,
              manually_overridden, override_reason, overridden_by, overridden_at,
              created_at, completed_at
       FROM jean_ci_check_runs
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      pageParams
    ),
    pool.query(`SELECT COUNT(*) FROM jean_ci_check_runs ${whereSql}`, params),
  ]);

  const total = parseInt(countResult.rows[0].count || '0', 10);
  return { items: items.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getCheckRunsForPR(
  repo: string,
  prNumber: number,
  headSha?: string
): Promise<CheckRunSummaryRecord[]> {
  const params: unknown[] = [repo, prNumber];
  let shaClause = '';
  if (headSha) {
    params.push(`${headSha}%`);
    shaClause = `AND head_sha LIKE $3`;
  }
  const result = await pool.query(
    `SELECT id, github_check_id, repo, pr_number, check_name, check_identity, head_sha,
            status, conclusion, title, summary, pr_title,
            manually_overridden, override_reason, overridden_by, overridden_at,
            created_at, completed_at
     FROM jean_ci_check_runs
     WHERE repo = $1 AND pr_number = $2 ${shaClause}
     ORDER BY created_at DESC, id DESC
     LIMIT 200`,
    params
  );
  return result.rows;
}

export interface CheckApprovalWaitSummary {
  waitingForApproval: boolean;
  pendingCount: number;
  hasDenied: boolean;
  segmentCount: number;
}

export function summarizeCheckApprovalRuns(
  checkStatus: string | null | undefined,
  rows: Array<{ status?: string | null; pending?: unknown; denied?: boolean | null }>,
  nowMs: number = Date.now(),
): CheckApprovalWaitSummary {
  const segmentCount = rows.length;
  const hasDenied = rows.some((row) => Boolean(row.denied));
  if (!checkStatus || checkStatus === 'completed') {
    return {
      waitingForApproval: false,
      pendingCount: 0,
      hasDenied,
      segmentCount,
    };
  }

  let pendingCount = 0;
  for (const row of rows) {
    if (row.status && terminalRun(row.status)) continue;
    if (!Array.isArray(row.pending)) continue;
    for (const item of row.pending) {
      if (!item || typeof item !== 'object') continue;
      const deadline = approvalDeadline(item as ApprovalPrompt);
      if (!deadline || deadline * 1000 > nowMs) {
        pendingCount += 1;
      }
    }
  }

  return {
    waitingForApproval: pendingCount > 0,
    pendingCount,
    hasDenied,
    segmentCount,
  };
}

// Read-only safe summary for bearer-token MCP clients: never exposes run IDs,
// commands, arguments, or approval prompts (those remain admin-browser-session only).
export async function getCheckApprovalSummary(checkId: number): Promise<CheckApprovalWaitSummary> {
  const [checkResult, runsResult] = await Promise.all([
    pool.query(`SELECT status FROM jean_ci_check_runs WHERE id = $1`, [checkId]),
    pool.query(
      `SELECT status, pending, denied
       FROM jean_ci_review_runs
       WHERE check_id = $1`,
      [checkId],
    ),
  ]);
  const checkStatus = checkResult.rows[0]?.status ?? null;
  return summarizeCheckApprovalRuns(checkStatus, runsResult.rows);
}

export interface McpTaskDbRecord {
  task_id: string;
  owner_subject: string;
  tool_name: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  status_message: string | null;
  input_requests: Record<string, unknown> | null;
  result: unknown;
  error: { code: number; message: string; data?: unknown } | null;
  metadata: Record<string, unknown>;
  ttl_ms: number | null;
  poll_interval_ms: number;
  created_at: Date;
  last_updated_at: Date;
  expires_at: Date | null;
}

export async function createMcpTaskRecord(data: {
  taskId: string;
  ownerSubject: string;
  toolName: string;
  status?: McpTaskDbRecord['status'];
  statusMessage?: string | null;
  metadata?: Record<string, unknown>;
  ttlMs?: number | null;
  pollIntervalMs?: number;
}): Promise<McpTaskDbRecord> {
  const ttlMs = data.ttlMs === undefined ? 3_600_000 : data.ttlMs;
  const expiresAt = ttlMs === null ? null : new Date(Date.now() + ttlMs);
  const result = await pool.query(
    `INSERT INTO jean_ci_mcp_tasks
       (task_id, owner_subject, tool_name, status, status_message, metadata, ttl_ms, poll_interval_ms, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      data.taskId,
      data.ownerSubject,
      data.toolName,
      data.status ?? 'working',
      data.statusMessage ?? null,
      JSON.stringify(data.metadata ?? {}),
      ttlMs,
      data.pollIntervalMs ?? 2500,
      expiresAt,
    ]
  );
  return result.rows[0];
}

export async function getMcpTaskRecord(taskId: string): Promise<McpTaskDbRecord | null> {
  const result = await pool.query(
    `SELECT * FROM jean_ci_mcp_tasks
     WHERE task_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [taskId]
  );
  return result.rows[0] || null;
}

export async function updateMcpTaskRecord(
  taskId: string,
  patch: {
    status?: McpTaskDbRecord['status'];
    statusMessage?: string | null;
    inputRequests?: Record<string, unknown> | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown } | null;
    metadata?: Record<string, unknown>;
  }
): Promise<McpTaskDbRecord | null> {
  const result = await pool.query(
    `UPDATE jean_ci_mcp_tasks
     SET status = COALESCE($2, status),
         status_message = CASE WHEN $3 THEN $4 ELSE status_message END,
         input_requests = CASE WHEN $5 THEN $6::jsonb ELSE input_requests END,
         result = CASE WHEN $7 THEN $8::jsonb ELSE result END,
         error = CASE WHEN $9 THEN $10::jsonb ELSE error END,
         metadata = CASE WHEN $11 THEN $12::jsonb ELSE metadata END,
         last_updated_at = CURRENT_TIMESTAMP
     WHERE task_id = $1
       AND status NOT IN ('completed', 'failed', 'cancelled')
     RETURNING *`,
    [
      taskId,
      patch.status ?? null,
      patch.statusMessage !== undefined,
      patch.statusMessage ?? null,
      patch.inputRequests !== undefined,
      patch.inputRequests == null ? null : JSON.stringify(patch.inputRequests),
      patch.result !== undefined,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      patch.error !== undefined,
      patch.error == null ? null : JSON.stringify(patch.error),
      patch.metadata !== undefined,
      patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
    ]
  );
  return result.rows[0] || null;
}

export async function cleanupExpiredMcpTasks(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM jean_ci_mcp_tasks WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
  );
  return result.rowCount || 0;
}

export async function reconcileInterruptedMcpTasks(startedBefore: Date): Promise<number> {
  const errorPayload = {
    code: -32603,
    message: 'Server restarted while task was in progress; re-run the tool if needed.',
  };
  const result = await pool.query(
    `UPDATE jean_ci_mcp_tasks
     SET status = 'failed',
         status_message = 'Interrupted by server restart',
         input_requests = NULL,
         error = $2::jsonb,
         last_updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('working', 'input_required')
       AND created_at < $1`,
    [startedBefore, JSON.stringify(errorPayload)]
  );
  return result.rowCount || 0;
}

export interface McpOAuthClientDbRecord {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  created_at: Date;
}

export interface McpOAuthPendingDbRecord {
  request_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scope: string;
  state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  csrf_token: string;
  expires_at: Date;
  created_at: Date;
}

export interface McpOAuthCodeDbRecord {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  user_id: string;
  user_login: string;
  used_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export interface McpOAuthTokenDbRecord {
  token_hash: string;
  token_type: 'access' | 'refresh';
  family_id: string;
  source_code_hash: string | null;
  client_id: string;
  resource: string;
  scope: string;
  user_id: string;
  user_login: string;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export async function createMcpOAuthClient(data: {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
}): Promise<McpOAuthClientDbRecord> {
  const result = await pool.query<McpOAuthClientDbRecord>(
    `INSERT INTO jean_ci_mcp_oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      data.clientId,
      data.clientSecretHash,
      data.clientName,
      JSON.stringify(data.redirectUris),
      JSON.stringify(data.grantTypes),
      data.tokenEndpointAuthMethod,
      data.scope,
    ],
  );
  return result.rows[0];
}

export async function getMcpOAuthClient(clientId: string): Promise<McpOAuthClientDbRecord | null> {
  const result = await pool.query<McpOAuthClientDbRecord>(
    `SELECT * FROM jean_ci_mcp_oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return result.rows[0] || null;
}

export async function createMcpOAuthPending(data: {
  requestId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  csrfToken: string;
  expiresAt: Date;
}): Promise<McpOAuthPendingDbRecord> {
  const result = await pool.query<McpOAuthPendingDbRecord>(
    `INSERT INTO jean_ci_mcp_oauth_pending
       (request_id, client_id, client_name, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.requestId,
      data.clientId,
      data.clientName,
      data.redirectUri,
      data.scope,
      data.state,
      data.codeChallenge,
      data.codeChallengeMethod,
      data.resource,
      data.csrfToken,
      data.expiresAt,
    ],
  );
  return result.rows[0];
}

export async function getMcpOAuthPending(requestId: string): Promise<McpOAuthPendingDbRecord | null> {
  const result = await pool.query<McpOAuthPendingDbRecord>(
    `SELECT * FROM jean_ci_mcp_oauth_pending WHERE request_id = $1 AND expires_at > NOW()`,
    [requestId],
  );
  return result.rows[0] || null;
}

export async function consumeMcpOAuthPending(requestId: string): Promise<McpOAuthPendingDbRecord | null> {
  const result = await pool.query<McpOAuthPendingDbRecord>(
    `DELETE FROM jean_ci_mcp_oauth_pending WHERE request_id = $1 AND expires_at > NOW() RETURNING *`,
    [requestId],
  );
  return result.rows[0] || null;
}

export async function createMcpOAuthCode(data: {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  userId: string;
  userLogin: string;
  expiresAt: Date;
}): Promise<McpOAuthCodeDbRecord> {
  const result = await pool.query<McpOAuthCodeDbRecord>(
    `INSERT INTO jean_ci_mcp_oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, resource, scope, user_id, user_login, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.codeHash,
      data.clientId,
      data.redirectUri,
      data.codeChallenge,
      data.resource,
      data.scope,
      data.userId,
      data.userLogin,
      data.expiresAt,
    ],
  );
  return result.rows[0];
}

export async function getMcpOAuthCode(codeHash: string): Promise<McpOAuthCodeDbRecord | null> {
  const result = await pool.query<McpOAuthCodeDbRecord>(
    `SELECT * FROM jean_ci_mcp_oauth_codes WHERE code_hash = $1`,
    [codeHash],
  );
  return result.rows[0] || null;
}

export async function markMcpOAuthCodeUsed(codeHash: string): Promise<McpOAuthCodeDbRecord | null> {
  const result = await pool.query<McpOAuthCodeDbRecord>(
    `UPDATE jean_ci_mcp_oauth_codes
     SET used_at = CURRENT_TIMESTAMP
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING *`,
    [codeHash],
  );
  return result.rows[0] || null;
}

export async function createMcpOAuthToken(data: {
  tokenHash: string;
  tokenType: 'access' | 'refresh';
  familyId: string;
  sourceCodeHash: string | null;
  clientId: string;
  resource: string;
  scope: string;
  userId: string;
  userLogin: string;
  expiresAt: Date;
}): Promise<McpOAuthTokenDbRecord> {
  const result = await pool.query<McpOAuthTokenDbRecord>(
    `INSERT INTO jean_ci_mcp_oauth_tokens
       (token_hash, token_type, family_id, source_code_hash, client_id, resource, scope, user_id, user_login, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.tokenHash,
      data.tokenType,
      data.familyId,
      data.sourceCodeHash,
      data.clientId,
      data.resource,
      data.scope,
      data.userId,
      data.userLogin,
      data.expiresAt,
    ],
  );
  return result.rows[0];
}

export async function getMcpOAuthToken(tokenHash: string): Promise<McpOAuthTokenDbRecord | null> {
  const result = await pool.query<McpOAuthTokenDbRecord>(
    `SELECT * FROM jean_ci_mcp_oauth_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

export async function revokeMcpOAuthToken(tokenHash: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jean_ci_mcp_oauth_tokens
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return (result.rowCount || 0) > 0;
}

const MCP_OAUTH_FAMILY_LOCK_NS = 918273;

export async function revokeMcpOAuthTokensByFamily(familyId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [MCP_OAUTH_FAMILY_LOCK_NS, familyId]);
    const result = await client.query(
      `UPDATE jean_ci_mcp_oauth_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    await client.query('COMMIT');
    return result.rowCount || 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeMcpOAuthTokensByCode(sourceCodeHash: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT code_hash FROM jean_ci_mcp_oauth_codes WHERE code_hash = $1 FOR UPDATE`, [sourceCodeHash]);
    const families = await client.query<{ family_id: string }>(
      `SELECT DISTINCT family_id FROM jean_ci_mcp_oauth_tokens WHERE source_code_hash = $1 ORDER BY family_id`,
      [sourceCodeHash],
    );
    for (const fam of families.rows) {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [MCP_OAUTH_FAMILY_LOCK_NS, fam.family_id]);
    }
    const result = await client.query(
      `UPDATE jean_ci_mcp_oauth_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE source_code_hash = $1 AND revoked_at IS NULL`,
      [sourceCodeHash],
    );
    await client.query('COMMIT');
    return result.rowCount || 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type AtomicOAuthCodeExchangeResult =
  | { status: 'issued' }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'replayed' };

export async function exchangeMcpOAuthCodeAtomic(params: {
  codeHash: string;
  accessToken: {
    tokenHash: string;
    familyId: string;
    clientId: string;
    resource: string;
    scope: string;
    userId: string;
    userLogin: string;
    expiresAt: Date;
  };
  refreshToken: {
    tokenHash: string;
    familyId: string;
    clientId: string;
    resource: string;
    scope: string;
    userId: string;
    userLogin: string;
    expiresAt: Date;
  };
}): Promise<AtomicOAuthCodeExchangeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const codeRes = await client.query<McpOAuthCodeDbRecord>(
      `SELECT * FROM jean_ci_mcp_oauth_codes WHERE code_hash = $1 FOR UPDATE`,
      [params.codeHash],
    );
    const row = codeRes.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return { status: 'not_found' };
    }
    if (row.used_at) {
      const families = await client.query<{ family_id: string }>(
        `SELECT DISTINCT family_id FROM jean_ci_mcp_oauth_tokens WHERE source_code_hash = $1 ORDER BY family_id`,
        [params.codeHash],
      );
      for (const fam of families.rows) {
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [MCP_OAUTH_FAMILY_LOCK_NS, fam.family_id]);
      }
      await client.query(
        `UPDATE jean_ci_mcp_oauth_tokens
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE source_code_hash = $1 AND revoked_at IS NULL`,
        [params.codeHash],
      );
      await client.query('COMMIT');
      return { status: 'replayed' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('COMMIT');
      return { status: 'expired' };
    }

    await client.query(
      `UPDATE jean_ci_mcp_oauth_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = $1`,
      [params.codeHash],
    );

    const insertSql = `INSERT INTO jean_ci_mcp_oauth_tokens
       (token_hash, token_type, family_id, source_code_hash, client_id, resource, scope, user_id, user_login, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    await client.query(insertSql, [
      params.accessToken.tokenHash,
      'access',
      params.accessToken.familyId,
      params.codeHash,
      params.accessToken.clientId,
      params.accessToken.resource,
      params.accessToken.scope,
      params.accessToken.userId,
      params.accessToken.userLogin,
      params.accessToken.expiresAt,
    ]);
    await client.query(insertSql, [
      params.refreshToken.tokenHash,
      'refresh',
      params.refreshToken.familyId,
      params.codeHash,
      params.refreshToken.clientId,
      params.refreshToken.resource,
      params.refreshToken.scope,
      params.refreshToken.userId,
      params.refreshToken.userLogin,
      params.refreshToken.expiresAt,
    ]);

    await client.query('COMMIT');
    return { status: 'issued' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type AtomicOAuthRefreshRotateResult =
  | { status: 'rotated' }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'replayed' };

export async function rotateMcpOAuthRefreshTokenAtomic(params: {
  refreshTokenHash: string;
  familyId: string;
  accessToken: {
    tokenHash: string;
    sourceCodeHash: string | null;
    clientId: string;
    resource: string;
    scope: string;
    userId: string;
    userLogin: string;
    expiresAt: Date;
  };
  nextRefreshToken: {
    tokenHash: string;
    sourceCodeHash: string | null;
    clientId: string;
    resource: string;
    scope: string;
    userId: string;
    userLogin: string;
    expiresAt: Date;
  };
}): Promise<AtomicOAuthRefreshRotateResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      MCP_OAUTH_FAMILY_LOCK_NS,
      params.familyId,
    ]);
    const tokenRes = await client.query<McpOAuthTokenDbRecord>(
      `SELECT * FROM jean_ci_mcp_oauth_tokens WHERE token_hash = $1 FOR UPDATE`,
      [params.refreshTokenHash],
    );
    const row = tokenRes.rows[0];
    if (!row || row.token_type !== 'refresh' || row.family_id !== params.familyId) {
      await client.query('COMMIT');
      return { status: 'not_found' };
    }
    if (row.revoked_at) {
      await client.query(
        `UPDATE jean_ci_mcp_oauth_tokens
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [params.familyId],
      );
      await client.query('COMMIT');
      return { status: 'replayed' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('COMMIT');
      return { status: 'expired' };
    }

    await client.query(
      `UPDATE jean_ci_mcp_oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1`,
      [params.refreshTokenHash],
    );

    const insertSql = `INSERT INTO jean_ci_mcp_oauth_tokens
       (token_hash, token_type, family_id, source_code_hash, client_id, resource, scope, user_id, user_login, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    await client.query(insertSql, [
      params.accessToken.tokenHash,
      'access',
      params.familyId,
      params.accessToken.sourceCodeHash,
      params.accessToken.clientId,
      params.accessToken.resource,
      params.accessToken.scope,
      params.accessToken.userId,
      params.accessToken.userLogin,
      params.accessToken.expiresAt,
    ]);
    await client.query(insertSql, [
      params.nextRefreshToken.tokenHash,
      'refresh',
      params.familyId,
      params.nextRefreshToken.sourceCodeHash,
      params.nextRefreshToken.clientId,
      params.nextRefreshToken.resource,
      params.nextRefreshToken.scope,
      params.nextRefreshToken.userId,
      params.nextRefreshToken.userLogin,
      params.nextRefreshToken.expiresAt,
    ]);

    await client.query('COMMIT');
    return { status: 'rotated' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupExpiredMcpOAuth(): Promise<number> {
  const [p, c, t] = await Promise.all([
    pool.query(`DELETE FROM jean_ci_mcp_oauth_pending WHERE expires_at <= NOW()`),
    pool.query(`DELETE FROM jean_ci_mcp_oauth_codes WHERE expires_at <= NOW() - INTERVAL '1 hour'`),
    pool.query(`DELETE FROM jean_ci_mcp_oauth_tokens WHERE expires_at <= NOW() - INTERVAL '1 day'`),
  ]);
  return (p.rowCount || 0) + (c.rowCount || 0) + (t.rowCount || 0);
}

// =============================================================================
// MCP Events (io.modelcontextprotocol/events — SEP-3415)
// =============================================================================

export interface McpEventDbRecord {
  id: string | number;
  event_id: string;
  name: string;
  repo: string | null;
  pr_number: number | null;
  conclusion: string | null;
  check_name: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}

export interface McpEventSubscriptionDbRecord {
  subscription_key_hash: string;
  subscription_id: string;
  principal: string;
  oauth_token_family_id: string | null;
  event_name: string;
  arguments_json: Record<string, unknown>;
  callback_url: string;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  expires_at: Date;
  last_cursor_id: string | number;
  active: boolean;
  consecutive_failures: number;
  last_delivery_at: Date | null;
  last_error: string | null;
  failed_since: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertMcpEvent(data: {
  eventId: string;
  name: string;
  repo?: string | null;
  prNumber?: number | null;
  conclusion?: string | null;
  checkName?: string | null;
  payload: Record<string, unknown>;
}): Promise<McpEventDbRecord> {
  const result = await pool.query<McpEventDbRecord>(
    `INSERT INTO jean_ci_mcp_events (event_id, name, repo, pr_number, conclusion, check_name, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
     RETURNING *`,
    [
      data.eventId,
      data.name,
      data.repo ?? null,
      data.prNumber ?? null,
      data.conclusion ?? null,
      data.checkName ?? null,
      JSON.stringify(data.payload),
    ],
  );
  return result.rows[0];
}

export async function getMcpEventStreamBounds(): Promise<{ latestId: number; oldestId: number | null }> {
  const result = await pool.query<{ latest_id: string | null; oldest_id: string | null }>(
    `SELECT
       COALESCE((SELECT MAX(id) FROM jean_ci_mcp_events), 0) AS latest_id,
       (SELECT MIN(id) FROM jean_ci_mcp_events) AS oldest_id`,
  );
  const row = result.rows[0];
  return {
    latestId: Number(row?.latest_id || 0),
    oldestId: row?.oldest_id !== null && row?.oldest_id !== undefined ? Number(row.oldest_id) : null,
  };
}

export async function queryMcpEvents(params: {
  name: string;
  afterId: number;
  minCreatedAt?: Date | null;
  repo?: string;
  prNumber?: number;
  conclusion?: string;
  checkName?: string;
  limit: number;
  order?: 'asc' | 'desc';
}): Promise<McpEventDbRecord[]> {
  const where: string[] = ['name = $1', 'id > $2'];
  const values: unknown[] = [params.name, params.afterId];
  let idx = 3;

  if (params.minCreatedAt) {
    where.push(`created_at >= $${idx++}`);
    values.push(params.minCreatedAt);
  }
  if (params.repo) {
    where.push(`repo = $${idx++}`);
    values.push(params.repo);
  }
  if (params.prNumber !== undefined) {
    where.push(`pr_number = $${idx++}`);
    values.push(params.prNumber);
  }
  if (params.conclusion) {
    where.push(`conclusion = $${idx++}`);
    values.push(params.conclusion);
  }
  if (params.checkName) {
    where.push(`LOWER(check_name) = LOWER($${idx++})`);
    values.push(params.checkName);
  }

  values.push(params.limit);
  const direction = params.order === 'desc' ? 'DESC' : 'ASC';
  const result = await pool.query<McpEventDbRecord>(
    `SELECT * FROM jean_ci_mcp_events
     WHERE ${where.join(' AND ')}
     ORDER BY id ${direction}
     LIMIT $${idx}`,
    values,
  );
  return result.rows;
}

export async function hasSkippedMcpEventsBeforeFloor(params: {
  name: string;
  afterId: number;
  minCreatedAt: Date;
}): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM jean_ci_mcp_events
       WHERE name = $1 AND id > $2 AND created_at < $3
     ) AS exists`,
    [params.name, params.afterId, params.minCreatedAt],
  );
  return Boolean(result.rows[0]?.exists);
}

export async function getMcpEventSubscriptionByKeyHash(
  keyHash: string,
): Promise<McpEventSubscriptionDbRecord | null> {
  const result = await pool.query<McpEventSubscriptionDbRecord>(
    `SELECT * FROM jean_ci_mcp_event_subscriptions WHERE subscription_key_hash = $1`,
    [keyHash],
  );
  return result.rows[0] || null;
}

export async function countActiveMcpEventSubscriptionsForPrincipal(principal: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM jean_ci_mcp_event_subscriptions
     WHERE principal = $1 AND expires_at > NOW()`,
    [principal],
  );
  return Number(result.rows[0]?.count || 0);
}

export class McpEventSubscriptionQuotaExceededError extends Error {
  readonly maxSubscriptions: number;
  constructor(maxSubscriptions: number) {
    super(`Active webhook subscription quota exceeded (max ${maxSubscriptions} per principal).`);
    this.name = 'McpEventSubscriptionQuotaExceededError';
    this.maxSubscriptions = maxSubscriptions;
  }
}

export async function upsertMcpEventSubscription(data: {
  subscriptionKeyHash: string;
  subscriptionId: string;
  principal: string;
  oauthTokenFamilyId: string | null;
  eventName: string;
  argumentsJson: Record<string, unknown>;
  callbackUrl: string;
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
  expiresAt: Date;
  lastCursorId: number;
  maxActivePerPrincipal?: number;
}): Promise<McpEventSubscriptionDbRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('mcp_event_sub_quota'), hashtext($1))`,
      [data.principal],
    );
    if (data.maxActivePerPrincipal !== undefined) {
      const existingRes = await client.query<{ is_active_refresh: boolean }>(
        `SELECT (expires_at > NOW()) AS is_active_refresh
         FROM jean_ci_mcp_event_subscriptions
         WHERE subscription_key_hash = $1`,
        [data.subscriptionKeyHash],
      );
      const isActiveRefresh = Boolean(existingRes.rows[0]?.is_active_refresh);
      if (!isActiveRefresh) {
        const countRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM jean_ci_mcp_event_subscriptions
           WHERE principal = $1 AND expires_at > NOW()`,
          [data.principal],
        );
        if (Number(countRes.rows[0]?.count || 0) >= data.maxActivePerPrincipal) {
          throw new McpEventSubscriptionQuotaExceededError(data.maxActivePerPrincipal);
        }
      }
    }
    const result = await client.query<McpEventSubscriptionDbRecord>(
      `INSERT INTO jean_ci_mcp_event_subscriptions (
         subscription_key_hash, subscription_id, principal, oauth_token_family_id,
         event_name, arguments_json, callback_url, secret,
         previous_secret, previous_secret_expires_at, expires_at,
         last_cursor_id, active, consecutive_failures, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, TRUE, 0, CURRENT_TIMESTAMP)
       ON CONFLICT (subscription_key_hash) DO UPDATE SET
         oauth_token_family_id = EXCLUDED.oauth_token_family_id,
         secret = EXCLUDED.secret,
         previous_secret = EXCLUDED.previous_secret,
         previous_secret_expires_at = EXCLUDED.previous_secret_expires_at,
         expires_at = EXCLUDED.expires_at,
         last_cursor_id = CASE
           WHEN jean_ci_mcp_event_subscriptions.expires_at <= NOW() THEN EXCLUDED.last_cursor_id
           ELSE GREATEST(jean_ci_mcp_event_subscriptions.last_cursor_id, EXCLUDED.last_cursor_id)
         END,
         active = TRUE,
         consecutive_failures = 0,
         last_error = NULL,
         failed_since = NULL,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        data.subscriptionKeyHash,
        data.subscriptionId,
        data.principal,
        data.oauthTokenFamilyId,
        data.eventName,
        JSON.stringify(data.argumentsJson),
        data.callbackUrl,
        data.secret,
        data.previousSecret,
        data.previousSecretExpiresAt,
        data.expiresAt,
        data.lastCursorId,
      ],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function advanceMcpEventSubscriptionCursor(
  subscriptionKeyHash: string,
  minCursorId: number,
): Promise<void> {
  await pool.query(
    `UPDATE jean_ci_mcp_event_subscriptions
     SET last_cursor_id = GREATEST(last_cursor_id, $2),
         updated_at = CURRENT_TIMESTAMP
     WHERE subscription_key_hash = $1`,
    [subscriptionKeyHash, minCursorId],
  );
}

export async function deleteMcpEventSubscriptionByKeyHash(keyHash: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM jean_ci_mcp_event_subscriptions WHERE subscription_key_hash = $1`,
    [keyHash],
  );
  return (result.rowCount || 0) > 0;
}

export async function listActiveMcpEventSubscriptionsByEventName(
  eventName: string,
): Promise<McpEventSubscriptionDbRecord[]> {
  const result = await pool.query<McpEventSubscriptionDbRecord>(
    `SELECT * FROM jean_ci_mcp_event_subscriptions
     WHERE event_name = $1 AND active = TRUE AND expires_at > NOW()
     ORDER BY created_at ASC`,
    [eventName],
  );
  return result.rows;
}

export async function updateMcpEventSubscriptionDeliveryStatus(params: {
  subscriptionKeyHash: string;
  active: boolean;
  consecutiveFailures: number;
  lastDeliveryAt?: Date | null;
  lastError: string | null;
  failedSince?: Date | null;
  lastCursorId?: number;
}): Promise<void> {
  await pool.query(
    `UPDATE jean_ci_mcp_event_subscriptions
     SET active = $2,
         consecutive_failures = $3,
         last_delivery_at = COALESCE($4, last_delivery_at),
         last_error = $5,
         failed_since = $6,
         last_cursor_id = GREATEST(last_cursor_id, COALESCE($7, last_cursor_id)),
         updated_at = CURRENT_TIMESTAMP
     WHERE subscription_key_hash = $1`,
    [
      params.subscriptionKeyHash,
      params.active,
      params.consecutiveFailures,
      params.lastDeliveryAt ?? null,
      params.lastError,
      params.failedSince ?? null,
      params.lastCursorId ?? null,
    ],
  );
}

export async function isMcpEventEndpointVerified(
  principal: string,
  callbackUrl: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM jean_ci_mcp_event_verified_endpoints
       WHERE principal = $1 AND callback_url = $2 AND expires_at > NOW()
     ) AS exists`,
    [principal, callbackUrl],
  );
  return Boolean(result.rows[0]?.exists);
}

export async function markMcpEventEndpointVerified(
  principal: string,
  callbackUrl: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO jean_ci_mcp_event_verified_endpoints (principal, callback_url, verified_at, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
     ON CONFLICT (principal, callback_url) DO UPDATE SET
       verified_at = CURRENT_TIMESTAMP,
       expires_at = EXCLUDED.expires_at`,
    [principal, callbackUrl, expiresAt],
  );
}

export async function hasActiveMcpOAuthFamily(familyId: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM jean_ci_mcp_oauth_tokens
       WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ) AS exists`,
    [familyId],
  );
  return Boolean(result.rows[0]?.exists);
}

export async function isApiTokenActive(tokenId: number): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM jean_ci_api_tokens
       WHERE id = $1 AND revoked_at IS NULL
     ) AS exists`,
    [tokenId],
  );
  return Boolean(result.rows[0]?.exists);
}

export async function cleanupExpiredMcpEvents(retentionDays = 14): Promise<number> {
  const [e, s, v] = await Promise.all([
    pool.query(`DELETE FROM jean_ci_mcp_events WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`, [
      Math.max(1, Math.floor(retentionDays)),
    ]),
    pool.query(`DELETE FROM jean_ci_mcp_event_subscriptions WHERE expires_at <= NOW()`),
    pool.query(`DELETE FROM jean_ci_mcp_event_verified_endpoints WHERE expires_at <= NOW()`),
  ]);
  return (e.rowCount || 0) + (s.rowCount || 0) + (v.rowCount || 0);
}



