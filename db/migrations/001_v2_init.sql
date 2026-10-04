-- migrate:up
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kiotviet_retailer TEXT,
  processing_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (processing_mode IN ('legacy', 'v2')),
  config JSONB NOT NULL DEFAULT '{"daily_summary_enabled":false,"daily_summary_hour":20,"price_alert_threshold_pct":10}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zalo_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invite_attempt_count INT NOT NULL DEFAULT 0,
  invite_lockout_until TIMESTAMPTZ,
  invite_last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  zalo_user_id UUID NOT NULL REFERENCES zalo_users(id),
  role TEXT NOT NULL DEFAULT 'staff'
    CHECK (role IN ('owner', 'staff', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  invited_by UUID REFERENCES tenant_users(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, zalo_user_id)
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  code_hash BYTEA NOT NULL,
  code_hint TEXT NOT NULL,
  target_role TEXT NOT NULL DEFAULT 'staff'
    CHECK (target_role IN ('owner', 'staff')),
  created_by UUID REFERENCES tenant_users(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'revoked')),
  used_by UUID REFERENCES zalo_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  lockout_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secret_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  secret_type TEXT NOT NULL CHECK (secret_type IN ('kiotviet_token')),
  version INT NOT NULL,
  encrypted_dek BYTEA NOT NULL,
  encrypted_value BYTEA NOT NULL,
  dek_nonce BYTEA NOT NULL,
  value_nonce BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  wipe_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, secret_type, version)
);

CREATE TABLE IF NOT EXISTS inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  zalo_user_id UUID NOT NULL REFERENCES zalo_users(id),
  zalo_msg_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  file_url TEXT,
  file_storage_key TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'enqueued', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, zalo_msg_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key_scope TEXT NOT NULL,
  key_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE (tenant_id, key_scope, key_value)
);

CREATE TABLE IF NOT EXISTS pending_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  zalo_user_id UUID NOT NULL REFERENCES zalo_users(id),
  platform_user_id TEXT,
  message_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  flushed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'flushed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_subject TEXT NOT NULL,
  actor_email TEXT,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oidc', 'break_glass')),
  action TEXT NOT NULL,
  target_tenant_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_codes_hash_active ON invite_codes (code_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_invite_codes_hash ON invite_codes (code_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tenant_users_zalo ON tenant_users (zalo_user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_secrets_tenant_active ON secret_versions (tenant_id, secret_type, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_notifications (zalo_user_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbound_events_tenant_status ON inbound_events (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_inbound_events_created ON inbound_events (created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status ON jobs (tenant_id, status, available_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant_scope ON idempotency_keys (tenant_id, key_scope);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs (created_at DESC);

COMMIT;

-- migrate:down
BEGIN;

DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS pending_notifications;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS inbound_events;
DROP TABLE IF EXISTS secret_versions;
DROP TABLE IF EXISTS invite_codes;
DROP TABLE IF EXISTS tenant_users;
DROP TABLE IF EXISTS zalo_users;
DROP TABLE IF EXISTS tenants;

COMMIT;
