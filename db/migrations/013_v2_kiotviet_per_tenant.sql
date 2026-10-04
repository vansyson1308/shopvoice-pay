-- migrate:up
-- Phase 5: Per-tenant KiotViet credentials and OAuth token caching.
-- Changes:
--   1. Add kiotviet_client_id column to tenants (alongside existing kiotviet_retailer)
--   2. Create kiotviet_token_cache table for OAuth access token caching
--   3. RLS + grants for new table

BEGIN;

-- ============================================================
-- STEP 1: Add KiotViet client_id to tenants (secret stored in secret_versions)
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS kiotviet_client_id TEXT;

-- ============================================================
-- STEP 2: Create OAuth token cache (short-lived access tokens)
-- ============================================================

CREATE TABLE IF NOT EXISTS kiotviet_token_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  access_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_kiotviet_token_cache_tenant
  ON kiotviet_token_cache (tenant_id);

ALTER TABLE kiotviet_token_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiotviet_token_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_kiotviet_token_cache_app_user ON kiotviet_token_cache
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON kiotviet_token_cache TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE SELECT, INSERT, UPDATE, DELETE ON kiotviet_token_cache FROM groceryclaw_app_user;
DROP POLICY IF EXISTS rls_kiotviet_token_cache_app_user ON kiotviet_token_cache;
ALTER TABLE IF EXISTS kiotviet_token_cache DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS kiotviet_token_cache;

ALTER TABLE tenants DROP COLUMN IF EXISTS kiotviet_client_id;

COMMIT;
