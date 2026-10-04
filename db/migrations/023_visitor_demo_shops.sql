-- migrate:up
-- Migration 023: "Try the demo" gives every console visitor a private sample
-- shop, so one judge's approvals never land in another judge's shop.
--  * sandbox_shops gains kind: 'account' (OAuth sign-up), 'visitor' (console
--    visitor) or 'demo' (the shared seeded demo tenant).
--  * demo_shop_create: a visitor shop plus its static MCP token (hash only).
--  * sandbox_reset: re-seeds a sample shop on demand; refuses real shops.
--  * demo_shops_cleanup: removes visitor shops idle longer than N days
--    (delete_visitor_shop does the removal; not callable by the app role).
-- All three are SECURITY DEFINER, owned by the bootstrap role (as in 017/018),
-- and touch sample shops only.
BEGIN;

ALTER TABLE sandbox_shops ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'account';
ALTER TABLE sandbox_shops DROP CONSTRAINT IF EXISTS sandbox_shops_kind_check;
ALTER TABLE sandbox_shops ADD CONSTRAINT sandbox_shops_kind_check CHECK (kind IN ('account', 'visitor', 'demo'));

CREATE OR REPLACE FUNCTION demo_shop_create(p_token_hash TEXT, p_catalogue JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_user UUID;
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid token hash';
  END IF;
  INSERT INTO tenants (id, name, status, processing_mode)
  VALUES (v_tenant, COALESCE(p_catalogue->'profiles'->'en'->>'shop_name', 'Your demo shop (sample data)'), 'active', 'v2');
  INSERT INTO platform_users (platform_user_id, display_name, platform)
  VALUES ('visitor:' || v_tenant::text, 'ShopVoice demo visitor', 'telegram')
  RETURNING id INTO v_user;
  INSERT INTO tenant_users (tenant_id, user_id, role, status) VALUES (v_tenant, v_user, 'owner', 'active');
  INSERT INTO sandbox_shops (tenant_id, seeded_on, locale, kind) VALUES (v_tenant, v_today, 'en', 'visitor');
  PERFORM seed_sandbox_shop(v_tenant, v_user, p_catalogue, v_today, 'en');
  INSERT INTO mcp_access_tokens (tenant_id, token_hash, label) VALUES (v_tenant, p_token_hash, 'try-demo visitor');
  RETURN v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION sandbox_reset(p_tenant UUID, p_catalogue JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
  v_user UUID;
BEGIN
  UPDATE sandbox_shops SET seeded_on = v_today WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT user_id INTO v_user FROM tenant_users WHERE tenant_id = p_tenant AND role = 'owner' ORDER BY created_at LIMIT 1;
  DELETE FROM purchase_order_drafts WHERE tenant_id = p_tenant;
  PERFORM seed_sandbox_shop(p_tenant, v_user, p_catalogue, v_today, 'en');
  RETURN true;
END;
$$;

-- Removes one visitor shop. Imported tables reference tenants without ON
-- DELETE CASCADE (as handled in 018's web_account_delete); the ShopVoice
-- tables (017, 019+) cascade from tenants.
CREATE OR REPLACE FUNCTION delete_visitor_shop(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sandbox_shops WHERE tenant_id = p_tenant AND kind = 'visitor') THEN
    RETURN false;
  END IF;
  DELETE FROM sync_results WHERE tenant_id = p_tenant;
  DELETE FROM resolved_invoice_items WHERE tenant_id = p_tenant;
  DELETE FROM canonical_invoice_items WHERE tenant_id = p_tenant;
  DELETE FROM canonical_invoices WHERE tenant_id = p_tenant;
  DELETE FROM inbound_events WHERE tenant_id = p_tenant;
  DELETE FROM product_cache WHERE tenant_id = p_tenant;
  WITH gone AS (DELETE FROM tenant_users WHERE tenant_id = p_tenant RETURNING user_id)
  DELETE FROM platform_users u USING gone WHERE u.id = gone.user_id AND u.platform_user_id = 'visitor:' || p_tenant::text;
  DELETE FROM tenants WHERE id = p_tenant;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION demo_shops_cleanup(p_idle_days INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
  v_count INT := 0;
BEGIN
  FOR v_tenant IN
    SELECT s.tenant_id
      FROM sandbox_shops s
     WHERE s.kind = 'visitor'
       AND s.created_at < now() - make_interval(days => GREATEST(p_idle_days, 1))
       AND NOT EXISTS (
         SELECT 1 FROM mcp_access_tokens t
          WHERE t.tenant_id = s.tenant_id AND t.last_used_at > now() - make_interval(days => GREATEST(p_idle_days, 1))
       )
  LOOP
    IF delete_visitor_shop(v_tenant) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox_shops, purchase_order_drafts TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT ON mcp_access_tokens TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, DELETE ON platform_users, tenant_users TO groceryclaw_bootstrap_owner;
GRANT DELETE ON sync_results, resolved_invoice_items, canonical_invoice_items, canonical_invoices, inbound_events, product_cache TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, DELETE ON tenants TO groceryclaw_bootstrap_owner;
ALTER FUNCTION demo_shop_create(TEXT, JSONB) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION sandbox_reset(UUID, JSONB) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION demo_shops_cleanup(INT) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION delete_visitor_shop(UUID) OWNER TO groceryclaw_bootstrap_owner;
REVOKE ALL ON FUNCTION delete_visitor_shop(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION demo_shop_create(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reset(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION demo_shops_cleanup(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_shop_create(TEXT, JSONB) TO groceryclaw_app_user;
GRANT EXECUTE ON FUNCTION sandbox_reset(UUID, JSONB) TO groceryclaw_app_user;
GRANT EXECUTE ON FUNCTION demo_shops_cleanup(INT) TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE EXECUTE ON FUNCTION demo_shops_cleanup(INT) FROM groceryclaw_app_user;
REVOKE EXECUTE ON FUNCTION sandbox_reset(UUID, JSONB) FROM groceryclaw_app_user;
REVOKE EXECUTE ON FUNCTION demo_shop_create(TEXT, JSONB) FROM groceryclaw_app_user;
DROP FUNCTION IF EXISTS demo_shops_cleanup(INT);
SELECT delete_visitor_shop(tenant_id) FROM sandbox_shops WHERE kind = 'visitor';
DROP FUNCTION IF EXISTS delete_visitor_shop(UUID);
DROP FUNCTION IF EXISTS sandbox_reset(UUID, JSONB);
DROP FUNCTION IF EXISTS demo_shop_create(TEXT, JSONB);
DELETE FROM sandbox_shops WHERE kind = 'demo';
ALTER TABLE sandbox_shops DROP CONSTRAINT IF EXISTS sandbox_shops_kind_check;
ALTER TABLE sandbox_shops DROP COLUMN IF EXISTS kind;

COMMIT;
