-- migrate:up
-- Migration 017: ShopVoice (Alexa+ MCP) inventory, sales, reorder and voice audit tables.
-- All tables are tenant-scoped with the same RLS pattern as 006: ENABLE + FORCE,
-- policy on _rls_tenant_id(), grants to groceryclaw_app_user only.
-- tenant_id FKs use ON DELETE CASCADE so existing test fixtures that
-- DELETE FROM tenants keep working when demo data is present.
BEGIN;

CREATE TABLE IF NOT EXISTS shop_profiles (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  shop_name TEXT NOT NULL,
  display_currency TEXT NOT NULL DEFAULT 'VND' CHECK (display_currency ~ '^[A-Z]{3}$'),
  vnd_per_display_unit NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (vnd_per_display_unit > 0),
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  locale TEXT NOT NULL DEFAULT 'en-US',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  default_lead_time_days INT NOT NULL DEFAULT 2 CHECK (default_lead_time_days >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, supplier_code)
);

CREATE TABLE IF NOT EXISTS stock_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  on_hand_qty NUMERIC(18,3) NOT NULL DEFAULT 0,
  unit TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('kiotviet', 'manual', 'seed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS reorder_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  min_qty NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  reorder_qty NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  pack_size NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  unit_cost_vnd BIGINT NOT NULL DEFAULT 0 CHECK (unit_cost_vnd >= 0),
  preferred_supplier_code TEXT,
  lead_time_days INT NOT NULL DEFAULT 2 CHECK (lead_time_days >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS sales_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_date DATE NOT NULL,
  sku TEXT NOT NULL,
  qty_sold NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (qty_sold >= 0),
  revenue_vnd BIGINT NOT NULL DEFAULT 0 CHECK (revenue_vnd >= 0),
  revenue_display NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sale_date, sku)
);

CREATE TABLE IF NOT EXISTS purchase_order_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code TEXT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_vnd BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'sent', 'cancelled')),
  created_via TEXT NOT NULL DEFAULT 'voice' CHECK (created_via IN ('voice', 'manual')),
  -- Only a SHA-256 hash of the confirmation token is stored; the token itself
  -- is returned once to the caller.
  confirmation_token_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error')),
  latency_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_daily_tenant_date ON sales_daily (tenant_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_daily_tenant_sku_date ON sales_daily (tenant_id, sku, sale_date);
CREATE INDEX IF NOT EXISTS idx_po_drafts_tenant_status ON purchase_order_drafts (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_audit_log_tenant_created ON voice_audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_access_tokens_tenant ON mcp_access_tokens (tenant_id);

ALTER TABLE shop_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE reorder_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_access_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE shop_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_levels FORCE ROW LEVEL SECURITY;
ALTER TABLE reorder_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_access_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_shop_profiles_app_user ON shop_profiles;
CREATE POLICY rls_shop_profiles_app_user ON shop_profiles
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_suppliers_app_user ON suppliers;
CREATE POLICY rls_suppliers_app_user ON suppliers
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_stock_levels_app_user ON stock_levels;
CREATE POLICY rls_stock_levels_app_user ON stock_levels
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_reorder_rules_app_user ON reorder_rules;
CREATE POLICY rls_reorder_rules_app_user ON reorder_rules
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_sales_daily_app_user ON sales_daily;
CREATE POLICY rls_sales_daily_app_user ON sales_daily
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_purchase_order_drafts_app_user ON purchase_order_drafts;
CREATE POLICY rls_purchase_order_drafts_app_user ON purchase_order_drafts
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_voice_audit_log_app_user ON voice_audit_log;
CREATE POLICY rls_voice_audit_log_app_user ON voice_audit_log
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_mcp_access_tokens_app_user ON mcp_access_tokens;
CREATE POLICY rls_mcp_access_tokens_app_user ON mcp_access_tokens
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON shop_profiles TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_levels TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reorder_rules TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_daily TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE ON purchase_order_drafts TO groceryclaw_app_user;
-- Audit log is append-only for the runtime role.
GRANT SELECT, INSERT ON voice_audit_log TO groceryclaw_app_user;
-- Tokens are managed out-of-band; the runtime role only reads its own tenant's rows.
GRANT SELECT ON mcp_access_tokens TO groceryclaw_app_user;

-- Bearer token -> tenant resolution runs before tenant context exists, so it
-- needs a SECURITY DEFINER function (same approach as
-- resolve_membership_by_platform_user_id). Input is the SHA-256 hex digest;
-- the plaintext token never reaches the database.
CREATE OR REPLACE FUNCTION resolve_mcp_access_token(p_token_hash TEXT)
RETURNS TABLE (tenant_id UUID, token_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE mcp_access_tokens t
     SET last_used_at = now()
    FROM tenants tn
   WHERE t.token_hash = p_token_hash
     AND t.status = 'active'
     AND tn.id = t.tenant_id
     AND tn.status = 'active'
  RETURNING t.tenant_id, t.id;
END;
$$;

-- Owned by the BYPASSRLS bootstrap role (as in 004/012) so it also works on
-- managed Postgres where the migration user is not a superuser.
GRANT SELECT, UPDATE ON mcp_access_tokens TO groceryclaw_bootstrap_owner;
GRANT SELECT ON tenants TO groceryclaw_bootstrap_owner;
ALTER FUNCTION resolve_mcp_access_token(TEXT) OWNER TO groceryclaw_bootstrap_owner;
REVOKE ALL ON FUNCTION resolve_mcp_access_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_mcp_access_token(TEXT) TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE EXECUTE ON FUNCTION resolve_mcp_access_token(TEXT) FROM groceryclaw_app_user;
DROP FUNCTION IF EXISTS resolve_mcp_access_token(TEXT);
REVOKE SELECT, UPDATE ON mcp_access_tokens FROM groceryclaw_bootstrap_owner;

REVOKE SELECT ON mcp_access_tokens FROM groceryclaw_app_user;
REVOKE SELECT, INSERT ON voice_audit_log FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE ON purchase_order_drafts FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON sales_daily FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON reorder_rules FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON stock_levels FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON suppliers FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON shop_profiles FROM groceryclaw_app_user;

DROP POLICY IF EXISTS rls_mcp_access_tokens_app_user ON mcp_access_tokens;
DROP POLICY IF EXISTS rls_voice_audit_log_app_user ON voice_audit_log;
DROP POLICY IF EXISTS rls_purchase_order_drafts_app_user ON purchase_order_drafts;
DROP POLICY IF EXISTS rls_sales_daily_app_user ON sales_daily;
DROP POLICY IF EXISTS rls_reorder_rules_app_user ON reorder_rules;
DROP POLICY IF EXISTS rls_stock_levels_app_user ON stock_levels;
DROP POLICY IF EXISTS rls_suppliers_app_user ON suppliers;
DROP POLICY IF EXISTS rls_shop_profiles_app_user ON shop_profiles;

DROP TABLE IF EXISTS mcp_access_tokens;
DROP TABLE IF EXISTS voice_audit_log;
DROP TABLE IF EXISTS purchase_order_drafts;
DROP TABLE IF EXISTS sales_daily;
DROP TABLE IF EXISTS reorder_rules;
DROP TABLE IF EXISTS stock_levels;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS shop_profiles;

COMMIT;
