ALTER TABLE jean_ci_check_runs
  ADD COLUMN IF NOT EXISTS manually_overridden BOOLEAN DEFAULT FALSE;

ALTER TABLE jean_ci_check_runs
  ADD COLUMN IF NOT EXISTS override_reason TEXT;

ALTER TABLE jean_ci_check_runs
  ADD COLUMN IF NOT EXISTS overridden_by TEXT;

ALTER TABLE jean_ci_check_runs
  ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMP;
