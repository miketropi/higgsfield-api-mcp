-- 0001_init.sql — Higgsfield MCP gateway persistence (SPEC §40, §41, §66).
--
-- Tenant-scoped everywhere. Credential bindings are deliberately absent: they
-- live in mounted configuration, never in the database. Submission envelopes are
-- stored as AES-256-GCM envelopes (see repository.ts), so the encrypted columns
-- below only ever hold ciphertext.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  tenant_id text NOT NULL,
  id text NOT NULL,
  workspace_id text,
  provider text NOT NULL,
  provider_job_id text,
  capability text NOT NULL,
  model text,
  endpoint text,
  kind text NOT NULL CHECK (kind IN ('generation', 'custom_reference')),
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress double precision,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  input_summary jsonb NOT NULL,
  assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost jsonb,
  error jsonb,
  metadata jsonb,
  submission_state text NOT NULL CHECK (submission_state IN ('pending', 'submitting', 'acknowledged', 'outcome_unknown', 'rejected', 'cancelled')),
  tool text NOT NULL,
  concurrency_class text NOT NULL CHECK (concurrency_class IN ('image', 'video', 'other')),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS jobs_tenant_created_idx ON jobs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_provider_job_id_idx ON jobs (provider_job_id) WHERE provider_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  tenant_id text NOT NULL,
  id text NOT NULL,
  workspace_id text,
  provider text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video', 'audio', '3d')),
  mime_type text NOT NULL,
  -- Nullable: the documented provider output reports only a URL.
  size bigint,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  width integer,
  height integer,
  duration_seconds double precision,
  origin text NOT NULL CHECK (origin IN ('provider', 'upload', 'managed')),
  storage_key text,
  url_expires_at timestamptz,
  sha256 text,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS assets_tenant_created_idx ON assets (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id text NOT NULL,
  tool text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  job_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, tool, key)
);

CREATE TABLE IF NOT EXISTS submissions (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  job_kind text NOT NULL CHECK (job_kind IN ('generation', 'custom_reference')),
  concurrency_class text NOT NULL CHECK (concurrency_class IN ('image', 'video', 'other')),
  endpoint text NOT NULL,
  upstream_idempotency_key text NOT NULL,
  -- AES-256-GCM envelopes: never plaintext.
  body text NOT NULL,
  body_hash text NOT NULL,
  query_params text,
  webhook_url text,
  callback_token text,
  -- Hash only; the plaintext callback token is never stored.
  callback_token_hash text,
  state text NOT NULL CHECK (state IN ('pending', 'submitting', 'acknowledged', 'outcome_unknown', 'rejected', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  provider_job_id text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id)
);

-- Claim scan: pending/expired leases ordered by creation time.
CREATE INDEX IF NOT EXISTS submissions_claim_idx ON submissions (state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS submissions_provider_job_id_idx ON submissions (tenant_id, provider_job_id) WHERE provider_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_callback_token_hash_idx ON submissions (callback_token_hash) WHERE callback_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_reservations (
  job_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  day text NOT NULL,
  micro_usd bigint NOT NULL,
  provider_account_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  created_at timestamptz NOT NULL,
  settled_micro_usd bigint
);

CREATE INDEX IF NOT EXISTS usage_reservations_tenant_day_idx ON usage_reservations (tenant_id, day, state);

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reserve', 'settle', 'release')),
  micro_usd bigint NOT NULL,
  at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_tenant_at_idx ON usage_events (tenant_id, at DESC);

CREATE TABLE IF NOT EXISTS confirmations (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL,
  tool text NOT NULL,
  request_hash text NOT NULL,
  estimated_micro_usd bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  at timestamptz NOT NULL,
  event text NOT NULL,
  job_id text,
  asset_id text,
  token_id text,
  request_id text,
  details jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_at_idx ON audit_events (tenant_id, at DESC);
