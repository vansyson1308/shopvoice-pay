-- migrate:up
-- Migration 018: OAuth 2.1 authorization server for the ShopVoice MCP connector
-- (Claude directory), web accounts and per-account sandbox shops.
--
-- Access model: the runtime role (groceryclaw_app_user) gets NO table grants
-- on the new tables. RLS is ENABLEd and FORCEd with no policy, so direct
-- reads fail closed. All access goes through SECURITY DEFINER functions owned
-- by the BYPASSRLS bootstrap role, the same pattern as
-- resolve_mcp_access_token (017) and consume_invite_code (012). Tokens, codes
-- and client secrets are stored only as SHA-256 hex digests; passwords only as
-- scrypt hashes computed in the application.
BEGIN;

CREATE TABLE IF NOT EXISTS web_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sandbox_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  platform_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'vi')),
  is_sandbox BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_accounts_email ON web_accounts (email);

-- A sandbox shop is regenerated from the demo catalogue when its data is older
-- than today (shop timezone), so "yesterday" always has sales.
CREATE TABLE IF NOT EXISTS sandbox_shops (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  seeded_on DATE NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'vi')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY CHECK (length(client_id) BETWEEN 8 AND 512),
  client_name TEXT NOT NULL DEFAULT '' CHECK (length(client_name) <= 200),
  redirect_uris TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post')),
  client_secret_hash TEXT CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[0-9a-f]{64}$'),
  registration_type TEXT NOT NULL CHECK (registration_type IN ('dcr', 'cimd')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes TEXT[] NOT NULL,
  resource TEXT NOT NULL,
  family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id UUID NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account_client ON oauth_tokens (account_id, client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes (expires_at);

ALTER TABLE web_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_shops FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;

-- The bootstrap owner (BYPASSRLS) runs the functions below.
GRANT SELECT, INSERT, UPDATE, DELETE ON web_accounts, sandbox_shops, oauth_clients, oauth_codes, oauth_tokens
  TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, UPDATE ON tenants TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_profiles, suppliers, product_cache, stock_levels, reorder_rules,
  sales_daily, purchase_order_drafts, inbound_events, canonical_invoices, canonical_invoice_items,
  resolved_invoice_items, sync_results
  TO groceryclaw_bootstrap_owner;
GRANT SELECT, DELETE ON voice_audit_log TO groceryclaw_bootstrap_owner;
GRANT DELETE ON tenant_users, platform_users TO groceryclaw_bootstrap_owner;

-- ---------------------------------------------------------------------------
-- Sandbox shop: the deterministic demo catalogue (scripts/v2/gen_demo_seed.mjs
-- buildSandboxCatalogue) copied into one tenant. Same formulas as the SQL demo
-- seed: qty = round(base x weekday multiplier x noise% x today fraction).
-- Not granted to the runtime role; called by web_account_create / sandbox_refresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_sandbox_shop(p_tenant UUID, p_user UUID, p_catalogue JSONB, p_anchor DATE, p_locale TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days INT := (p_catalogue->>'sales_days')::int;
  v_fraction NUMERIC := (p_catalogue->>'today_fraction')::numeric;
  v_profile JSONB := COALESCE(p_catalogue->'profiles'->p_locale, p_catalogue->'profiles'->'en');
  v_rate NUMERIC := (v_profile->>'vnd_per_display_unit')::numeric;
  v_inv JSONB;
  v_item JSONB;
  v_event UUID;
  v_invoice UUID;
  v_item_id UUID;
  v_line INT;
  v_total BIGINT;
BEGIN
  DELETE FROM sync_results WHERE tenant_id = p_tenant;
  DELETE FROM resolved_invoice_items WHERE tenant_id = p_tenant;
  DELETE FROM canonical_invoice_items WHERE tenant_id = p_tenant;
  DELETE FROM canonical_invoices WHERE tenant_id = p_tenant;
  DELETE FROM inbound_events WHERE tenant_id = p_tenant;
  DELETE FROM purchase_order_drafts WHERE tenant_id = p_tenant;
  DELETE FROM sales_daily WHERE tenant_id = p_tenant;
  DELETE FROM reorder_rules WHERE tenant_id = p_tenant;
  DELETE FROM stock_levels WHERE tenant_id = p_tenant;
  DELETE FROM suppliers WHERE tenant_id = p_tenant;
  DELETE FROM product_cache WHERE tenant_id = p_tenant;
  DELETE FROM shop_profiles WHERE tenant_id = p_tenant;

  INSERT INTO shop_profiles (tenant_id, shop_name, display_currency, vnd_per_display_unit, timezone, locale)
  VALUES (p_tenant, v_profile->>'shop_name', v_profile->>'display_currency', v_rate,
          'Asia/Ho_Chi_Minh', v_profile->>'locale');

  INSERT INTO suppliers (tenant_id, supplier_code, name, phone, default_lead_time_days)
  SELECT p_tenant, s.code, s.name, s.phone, s.lead
    FROM jsonb_to_recordset(p_catalogue->'suppliers') AS s(code TEXT, name TEXT, phone TEXT, lead INT);

  CREATE TEMP TABLE IF NOT EXISTS sandbox_products (
    sku TEXT, name TEXT, unit TEXT, barcode TEXT, price BIGINT, unit_cost BIGINT, base NUMERIC, pack NUMERIC,
    supplier TEXT, lead INT, min_qty NUMERIC, reorder_qty NUMERIC, on_hand NUMERIC, noise INT[]
  ) ON COMMIT DROP;
  TRUNCATE sandbox_products;
  INSERT INTO sandbox_products
  SELECT p.sku, p.name, p.unit, p.barcode, p.price, p.unit_cost, p.base, p.pack, p.supplier, p.lead,
         p.min_qty, p.reorder_qty, p.on_hand,
         ARRAY(SELECT e::int FROM jsonb_array_elements_text(p.noise) WITH ORDINALITY AS x(e, i) ORDER BY i)
    FROM jsonb_to_recordset(p_catalogue->'products') AS p(
      sku TEXT, name TEXT, unit TEXT, barcode TEXT, price BIGINT, unit_cost BIGINT, base NUMERIC, pack NUMERIC,
      supplier TEXT, lead INT, min_qty NUMERIC, reorder_qty NUMERIC, on_hand NUMERIC, noise JSONB);

  INSERT INTO product_cache (tenant_id, sku, barcode, product_name, unit, active, base_price)
  SELECT p_tenant, sku, barcode, name, unit, true, price FROM sandbox_products;

  INSERT INTO stock_levels (tenant_id, sku, on_hand_qty, unit, source, updated_at)
  SELECT p_tenant, sku, on_hand, unit, 'seed', now() FROM sandbox_products;

  INSERT INTO reorder_rules (tenant_id, sku, min_qty, reorder_qty, pack_size, unit_cost_vnd, preferred_supplier_code, lead_time_days)
  SELECT p_tenant, sku, min_qty, reorder_qty, pack, unit_cost, supplier, lead FROM sandbox_products;

  INSERT INTO sales_daily (tenant_id, sale_date, sku, qty_sold, revenue_vnd, revenue_display)
  SELECT p_tenant, sale_date, sku, qty, qty * price, round(qty * price / v_rate, 2)
    FROM (
      SELECT p_anchor - (v_days - n.idx)::int AS sale_date, p.sku, p.price,
             GREATEST(0, round(p.base
               * ((p_catalogue->'weekday_multipliers')->>(extract(isodow FROM p_anchor - (v_days - n.idx)::int)::int - 1))::numeric
               * n.noise / 100.0
               * CASE WHEN n.idx = v_days THEN v_fraction ELSE 1 END)) AS qty
        FROM sandbox_products p
        CROSS JOIN LATERAL unnest(p.noise) WITH ORDINALITY AS n(noise, idx)
    ) s;

  FOR v_inv IN SELECT * FROM jsonb_array_elements(p_catalogue->'invoices') LOOP
    v_event := gen_random_uuid();
    v_invoice := gen_random_uuid();
    SELECT COALESCE(sum((i->>1)::bigint * (i->>2)::bigint), 0) INTO v_total FROM jsonb_array_elements(v_inv->'items') AS i;
    INSERT INTO inbound_events (id, tenant_id, user_id, message_id, event_type, payload, status)
    VALUES (v_event, p_tenant, p_user, 'sandbox-' || (v_inv->>'number'), 'image', '{"source":"sandbox_seed"}'::jsonb, 'completed');
    INSERT INTO canonical_invoices (id, tenant_id, inbound_event_id, invoice_fingerprint, supplier_code, invoice_number,
                                    invoice_date, currency, subtotal, total, created_at)
    VALUES (v_invoice, p_tenant, v_event, 'sandbox-' || (v_inv->>'number'), v_inv->>'supplier', v_inv->>'number',
            p_anchor - (v_inv->>'days_ago')::int, 'VND', v_total, v_total,
            ((p_anchor - (v_inv->>'days_ago')::int) + time '08:30') AT TIME ZONE 'Asia/Ho_Chi_Minh');
    v_line := 0;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_inv->'items') LOOP
      v_line := v_line + 1;
      v_item_id := gen_random_uuid();
      INSERT INTO canonical_invoice_items (id, tenant_id, canonical_invoice_id, line_no, sku, product_name, quantity, unit_price, line_total)
      SELECT v_item_id, p_tenant, v_invoice, v_line, v_item->>0, COALESCE(sp.name, v_item->>0),
             (v_item->>1)::numeric, (v_item->>2)::numeric, (v_item->>1)::numeric * (v_item->>2)::numeric
        FROM (SELECT 1) one LEFT JOIN sandbox_products sp ON sp.sku = v_item->>0;
      IF v_inv->>'state' <> 'arrived' THEN
        INSERT INTO resolved_invoice_items (tenant_id, canonical_invoice_id, canonical_item_id, status, resolved_sku, quantity)
        VALUES (p_tenant, v_invoice, v_item_id, 'resolved', v_item->>0, (v_item->>1)::numeric);
      END IF;
    END LOOP;
    IF v_inv->>'state' = 'synced' THEN
      INSERT INTO sync_results (tenant_id, canonical_invoice_id, external_system, external_reference_id, status)
      VALUES (p_tenant, v_invoice, 'kiotviet', 'PN-SANDBOX', 'success');
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Web accounts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_account_create(p_email TEXT, p_password_hash TEXT, p_locale TEXT, p_catalogue JSONB)
RETURNS TABLE (account_id UUID, tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account UUID := gen_random_uuid();
  v_tenant UUID := gen_random_uuid();
  v_user UUID;
  v_today DATE := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  INSERT INTO tenants (id, name, status, processing_mode)
  VALUES (v_tenant, COALESCE(p_catalogue->'profiles'->p_locale->>'shop_name', 'Demo shop (sample data)'), 'active', 'v2');

  INSERT INTO platform_users (platform_user_id, display_name, platform)
  VALUES ('web:' || v_account::text, 'ShopVoice web account', 'telegram')
  RETURNING id INTO v_user;

  INSERT INTO tenant_users (tenant_id, user_id, role, status)
  VALUES (v_tenant, v_user, 'owner', 'active');

  INSERT INTO web_accounts (id, email, password_hash, tenant_id, sandbox_tenant_id, platform_user_id, locale, is_sandbox)
  VALUES (v_account, lower(p_email), p_password_hash, v_tenant, v_tenant, v_user, p_locale, true);

  INSERT INTO sandbox_shops (tenant_id, seeded_on, locale) VALUES (v_tenant, v_today, p_locale);
  PERFORM seed_sandbox_shop(v_tenant, v_user, p_catalogue, v_today, p_locale);

  RETURN QUERY SELECT v_account, v_tenant;
END;
$$;

-- Re-seeds a sandbox shop at most once per day (shop timezone). Returns true
-- when it re-seeded. Real (invite-linked) tenants are never touched.
CREATE OR REPLACE FUNCTION sandbox_refresh(p_tenant UUID, p_catalogue JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_user UUID;
  v_locale TEXT;
BEGIN
  UPDATE sandbox_shops SET seeded_on = v_today
   WHERE tenant_id = p_tenant AND seeded_on < v_today
  RETURNING locale INTO v_locale;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT platform_user_id INTO v_user FROM web_accounts WHERE sandbox_tenant_id = p_tenant LIMIT 1;
  PERFORM seed_sandbox_shop(p_tenant, v_user, p_catalogue, v_today, v_locale);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION web_account_find_by_email(p_email TEXT)
RETURNS TABLE (account_id UUID, password_hash TEXT, status TEXT, locked_until TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.password_hash, a.status, a.locked_until FROM web_accounts a WHERE a.email = lower(p_email);
$$;

-- 5 failed logins lock the account for 15 minutes; a success resets the count.
CREATE OR REPLACE FUNCTION web_account_record_login(p_account_id UUID, p_success BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_success THEN
    UPDATE web_accounts SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
     WHERE id = p_account_id;
  ELSE
    UPDATE web_accounts
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           updated_at = now()
     WHERE id = p_account_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION web_account_get(p_account_id UUID)
RETURNS TABLE (account_id UUID, email TEXT, tenant_id UUID, shop_name TEXT, is_sandbox BOOLEAN, locale TEXT, status TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.email, a.tenant_id, COALESCE(sp.shop_name, t.name), a.is_sandbox, a.locale, a.status
    FROM web_accounts a
    JOIN tenants t ON t.id = a.tenant_id
    LEFT JOIN shop_profiles sp ON sp.tenant_id = a.tenant_id
   WHERE a.id = p_account_id;
$$;

-- Links an account to a real GroceryClaw shop through the existing invite-code
-- flow. The caller sets app.invite_pepper_b64 in the same transaction (as the
-- gateway does). A separate platform user ('web-link:<account>') keeps the
-- one-user-one-tenant rule of consume_invite_code. Existing tokens are revoked
-- so every client re-consents against the real shop.
CREATE OR REPLACE FUNCTION web_account_link_invite(p_account_id UUID, p_code TEXT)
RETURNS TABLE (ok BOOLEAN, tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_ok BOOLEAN;
  v_tenant UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM web_accounts a WHERE a.id = p_account_id AND a.status = 'active') THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;
  SELECT c.ok, c.tenant_id INTO v_ok, v_tenant FROM consume_invite_code('web-link:' || p_account_id::text, p_code) c;
  IF v_ok IS DISTINCT FROM true OR v_tenant IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;
  UPDATE web_accounts SET tenant_id = v_tenant, is_sandbox = false, updated_at = now() WHERE id = p_account_id;
  UPDATE oauth_tokens SET status = 'revoked', revoked_at = now() WHERE account_id = p_account_id AND status = 'active';
  RETURN QUERY SELECT true, v_tenant;
END;
$$;

-- ---------------------------------------------------------------------------
-- OAuth clients (DCR and CIMD)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oauth_register_client(
  p_client_id TEXT, p_client_name TEXT, p_redirect_uris TEXT[], p_auth_method TEXT,
  p_secret_hash TEXT, p_registration_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_registration_type = 'cimd' THEN
    -- A CIMD document is re-fetched and may change; keep the row in sync.
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, registration_type)
    VALUES (p_client_id, p_client_name, p_redirect_uris, 'none', NULL, 'cimd')
    ON CONFLICT (client_id) DO UPDATE
      SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris
      WHERE oauth_clients.registration_type = 'cimd';
  ELSE
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, registration_type)
    VALUES (p_client_id, p_client_name, p_redirect_uris, p_auth_method, p_secret_hash, 'dcr');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION oauth_get_client(p_client_id TEXT)
RETURNS TABLE (client_id TEXT, client_name TEXT, redirect_uris TEXT[], token_endpoint_auth_method TEXT,
               client_secret_hash TEXT, registration_type TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.client_id, c.client_name, c.redirect_uris, c.token_endpoint_auth_method, c.client_secret_hash, c.registration_type
    FROM oauth_clients c WHERE c.client_id = p_client_id;
$$;

-- DCR hygiene: drop dynamically registered clients unused for p_idle_days
-- and holding no live token. Also purges expired codes and long-dead tokens.
CREATE OR REPLACE FUNCTION oauth_cleanup(p_idle_days INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM oauth_tokens WHERE expires_at < now() - interval '7 days';
  DELETE FROM oauth_clients c
   WHERE c.registration_type = 'dcr'
     AND COALESCE(c.last_used_at, c.created_at) < now() - make_interval(days => p_idle_days)
     AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.client_id AND t.status = 'active' AND t.expires_at > now());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Authorization codes and tokens
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oauth_create_code(
  p_code_hash TEXT, p_client_id TEXT, p_account_id UUID, p_redirect_uri TEXT, p_code_challenge TEXT,
  p_scopes TEXT[], p_resource TEXT, p_ttl_seconds INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  VALUES (p_code_hash, p_client_id, p_account_id, p_redirect_uri, p_code_challenge, p_scopes, p_resource,
          now() + make_interval(secs => p_ttl_seconds));
  UPDATE oauth_clients SET last_used_at = now() WHERE client_id = p_client_id;
END;
$$;

-- Single use. A second redemption revokes every token issued from the code
-- (OAuth 2.1 section 4.1.3) and reports 'reused'.
CREATE OR REPLACE FUNCTION oauth_consume_code(p_code_hash TEXT)
RETURNS TABLE (outcome TEXT, client_id TEXT, account_id UUID, redirect_uri TEXT, code_challenge TEXT,
               scopes TEXT[], resource TEXT, family_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM oauth_codes c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF v.code_hash IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text[], NULL::text, NULL::uuid;
    RETURN;
  END IF;
  IF v.used_at IS NOT NULL THEN
    UPDATE oauth_tokens t SET status = 'revoked', revoked_at = now() WHERE t.family_id = v.family_id AND t.status <> 'revoked';
    RETURN QUERY SELECT 'reused'::text, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text[], NULL::text, NULL::uuid;
    RETURN;
  END IF;
  UPDATE oauth_codes c SET used_at = now() WHERE c.code_hash = p_code_hash;
  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text[], NULL::text, NULL::uuid;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v.client_id, v.account_id, v.redirect_uri, v.code_challenge, v.scopes, v.resource, v.family_id;
END;
$$;

CREATE OR REPLACE FUNCTION oauth_issue_tokens(
  p_family_id UUID, p_client_id TEXT, p_account_id UUID, p_scopes TEXT[], p_resource TEXT,
  p_access_hash TEXT, p_access_ttl INT, p_refresh_hash TEXT, p_refresh_ttl INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, account_id, scopes, resource, expires_at)
  VALUES (p_access_hash, 'access', p_family_id, p_client_id, p_account_id, p_scopes, p_resource,
          now() + make_interval(secs => p_access_ttl));
  IF p_refresh_hash IS NOT NULL THEN
    INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, account_id, scopes, resource, expires_at)
    VALUES (p_refresh_hash, 'refresh', p_family_id, p_client_id, p_account_id, p_scopes, p_resource,
            now() + make_interval(secs => p_refresh_ttl));
  END IF;
END;
$$;

-- Resolves an access token to its tenant. The tenant comes from the account
-- at request time, so linking a real shop (which also revokes tokens) can
-- never leave a token pointing at a stale tenant.
CREATE OR REPLACE FUNCTION oauth_resolve_access_token(p_hash TEXT)
RETURNS TABLE (tenant_id UUID, account_id UUID, client_id TEXT, scopes TEXT[], resource TEXT,
               expires_at TIMESTAMPTZ, is_sandbox BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  UPDATE oauth_tokens t SET last_used_at = now()
   WHERE t.token_hash = p_hash AND t.kind = 'access'
     AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute');
  RETURN QUERY
  SELECT a.tenant_id, t.account_id, t.client_id, t.scopes, t.resource, t.expires_at, a.is_sandbox
    FROM oauth_tokens t
    JOIN web_accounts a ON a.id = t.account_id AND a.status = 'active'
    JOIN tenants tn ON tn.id = a.tenant_id AND tn.status = 'active'
   WHERE t.token_hash = p_hash AND t.kind = 'access' AND t.status = 'active' AND t.expires_at > now();
END;
$$;

-- Refresh-token rotation with reuse detection. Presenting a refresh token that
-- was already rotated (or revoked) revokes the whole family.
CREATE OR REPLACE FUNCTION oauth_rotate_refresh(
  p_old_hash TEXT, p_client_id TEXT, p_access_hash TEXT, p_access_ttl INT, p_refresh_hash TEXT, p_refresh_ttl INT
)
RETURNS TABLE (outcome TEXT, account_id UUID, scopes TEXT[], resource TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v RECORD;
BEGIN
  SELECT t.*, (a.status = 'active') AS account_ok INTO v
    FROM oauth_tokens t JOIN web_accounts a ON a.id = t.account_id
   WHERE t.token_hash = p_old_hash AND t.kind = 'refresh'
   FOR UPDATE OF t;
  IF v.id IS NULL OR v.client_id <> p_client_id THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text[], NULL::text;
    RETURN;
  END IF;
  IF v.status <> 'active' THEN
    UPDATE oauth_tokens t SET status = 'revoked', revoked_at = now() WHERE t.family_id = v.family_id AND t.status <> 'revoked';
    RETURN QUERY SELECT 'reuse'::text, NULL::uuid, NULL::text[], NULL::text;
    RETURN;
  END IF;
  IF v.expires_at <= now() OR NOT v.account_ok THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text[], NULL::text;
    RETURN;
  END IF;
  UPDATE oauth_tokens t SET status = 'rotated' WHERE t.id = v.id;
  PERFORM oauth_issue_tokens(v.family_id, v.client_id, v.account_id, v.scopes, v.resource,
                             p_access_hash, p_access_ttl, p_refresh_hash, p_refresh_ttl);
  UPDATE oauth_clients c SET last_used_at = now() WHERE c.client_id = v.client_id;
  RETURN QUERY SELECT 'ok'::text, v.account_id, v.scopes, v.resource;
END;
$$;

-- RFC 7009: revoking either token of a grant revokes its whole family.
CREATE OR REPLACE FUNCTION oauth_revoke_token(p_hash TEXT, p_client_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family UUID;
BEGIN
  SELECT family_id INTO v_family FROM oauth_tokens WHERE token_hash = p_hash AND client_id = p_client_id;
  IF v_family IS NULL THEN
    RETURN false;
  END IF;
  UPDATE oauth_tokens SET status = 'revoked', revoked_at = now() WHERE family_id = v_family AND status <> 'revoked';
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION oauth_list_grants(p_account_id UUID)
RETURNS TABLE (client_id TEXT, client_name TEXT, registration_type TEXT, redirect_uris TEXT[], scopes TEXT[],
               first_granted_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.client_id, c.client_name, c.registration_type, c.redirect_uris,
         ARRAY(SELECT DISTINCT s FROM oauth_tokens t2, unnest(t2.scopes) s
                WHERE t2.account_id = p_account_id AND t2.client_id = c.client_id AND t2.status = 'active' ORDER BY s),
         min(t.created_at), max(COALESCE(t.last_used_at, t.created_at))
    FROM oauth_tokens t
    JOIN oauth_clients c ON c.client_id = t.client_id
   WHERE t.account_id = p_account_id AND t.status = 'active' AND t.expires_at > now()
   GROUP BY c.client_id, c.client_name, c.registration_type, c.redirect_uris
   ORDER BY max(COALESCE(t.last_used_at, t.created_at)) DESC;
$$;

CREATE OR REPLACE FUNCTION oauth_revoke_grant(p_account_id UUID, p_client_id TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE oauth_tokens SET status = 'revoked', revoked_at = now()
   WHERE account_id = p_account_id AND client_id = p_client_id AND status <> 'revoked';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Self-service account deletion (/account). Removes the account, its tokens
-- and codes (cascade), the web platform users, and every row of its sandbox
-- shop; the sandbox tenant row is kept as a suspended tombstone because older
-- tables reference tenants without ON DELETE CASCADE. A linked real shop is
-- untouched apart from losing this account's membership.
CREATE OR REPLACE FUNCTION web_account_delete(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sandbox UUID;
BEGIN
  SELECT sandbox_tenant_id INTO v_sandbox FROM web_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM web_accounts WHERE id = p_account_id;
  IF v_sandbox IS NOT NULL THEN
    DELETE FROM sync_results WHERE tenant_id = v_sandbox;
    DELETE FROM resolved_invoice_items WHERE tenant_id = v_sandbox;
    DELETE FROM canonical_invoice_items WHERE tenant_id = v_sandbox;
    DELETE FROM canonical_invoices WHERE tenant_id = v_sandbox;
    DELETE FROM inbound_events WHERE tenant_id = v_sandbox;
    DELETE FROM purchase_order_drafts WHERE tenant_id = v_sandbox;
    DELETE FROM voice_audit_log WHERE tenant_id = v_sandbox;
    DELETE FROM sales_daily WHERE tenant_id = v_sandbox;
    DELETE FROM reorder_rules WHERE tenant_id = v_sandbox;
    DELETE FROM stock_levels WHERE tenant_id = v_sandbox;
    DELETE FROM suppliers WHERE tenant_id = v_sandbox;
    DELETE FROM product_cache WHERE tenant_id = v_sandbox;
    DELETE FROM shop_profiles WHERE tenant_id = v_sandbox;
    DELETE FROM sandbox_shops WHERE tenant_id = v_sandbox;
    UPDATE tenants SET status = 'suspended', name = 'deleted sandbox', updated_at = now() WHERE id = v_sandbox;
  END IF;
  DELETE FROM tenant_users WHERE user_id IN (
    SELECT id FROM platform_users WHERE platform_user_id IN ('web:' || p_account_id::text, 'web-link:' || p_account_id::text));
  DELETE FROM platform_users WHERE platform_user_id IN ('web:' || p_account_id::text, 'web-link:' || p_account_id::text);
  RETURN true;
END;
$$;

-- Tool-call audit retention (privacy policy: 90 days).
CREATE OR REPLACE FUNCTION purge_voice_audit_log(p_days INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM voice_audit_log WHERE created_at < now() - make_interval(days => GREATEST(p_days, 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'seed_sandbox_shop(uuid, uuid, jsonb, date, text)',
    'web_account_create(text, text, text, jsonb)',
    'sandbox_refresh(uuid, jsonb)',
    'web_account_find_by_email(text)',
    'web_account_record_login(uuid, boolean)',
    'web_account_get(uuid)',
    'web_account_link_invite(uuid, text)',
    'oauth_register_client(text, text, text[], text, text, text)',
    'oauth_get_client(text)',
    'oauth_cleanup(int)',
    'oauth_create_code(text, text, uuid, text, text, text[], text, int)',
    'oauth_consume_code(text)',
    'oauth_issue_tokens(uuid, text, uuid, text[], text, text, int, text, int)',
    'oauth_resolve_access_token(text)',
    'oauth_rotate_refresh(text, text, text, int, text, int)',
    'oauth_revoke_token(text, text)',
    'oauth_list_grants(uuid)',
    'oauth_revoke_grant(uuid, text)',
    'web_account_delete(uuid)',
    'purge_voice_audit_log(int)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO groceryclaw_bootstrap_owner', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF fn NOT LIKE 'seed_sandbox_shop%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO groceryclaw_app_user', fn);
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- migrate:down
BEGIN;

DROP FUNCTION IF EXISTS purge_voice_audit_log(INT);
DROP FUNCTION IF EXISTS web_account_delete(UUID);
DROP FUNCTION IF EXISTS oauth_revoke_grant(UUID, TEXT);
DROP FUNCTION IF EXISTS oauth_list_grants(UUID);
DROP FUNCTION IF EXISTS oauth_revoke_token(TEXT, TEXT);
DROP FUNCTION IF EXISTS oauth_rotate_refresh(TEXT, TEXT, TEXT, INT, TEXT, INT);
DROP FUNCTION IF EXISTS oauth_resolve_access_token(TEXT);
DROP FUNCTION IF EXISTS oauth_issue_tokens(UUID, TEXT, UUID, TEXT[], TEXT, TEXT, INT, TEXT, INT);
DROP FUNCTION IF EXISTS oauth_consume_code(TEXT);
DROP FUNCTION IF EXISTS oauth_create_code(TEXT, TEXT, UUID, TEXT, TEXT, TEXT[], TEXT, INT);
DROP FUNCTION IF EXISTS oauth_cleanup(INT);
DROP FUNCTION IF EXISTS oauth_get_client(TEXT);
DROP FUNCTION IF EXISTS oauth_register_client(TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS web_account_link_invite(UUID, TEXT);
DROP FUNCTION IF EXISTS web_account_get(UUID);
DROP FUNCTION IF EXISTS web_account_record_login(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS web_account_find_by_email(TEXT);
DROP FUNCTION IF EXISTS sandbox_refresh(UUID, JSONB);
DROP FUNCTION IF EXISTS web_account_create(TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS seed_sandbox_shop(UUID, UUID, JSONB, DATE, TEXT);

REVOKE SELECT, INSERT, UPDATE, DELETE ON shop_profiles, suppliers, product_cache, stock_levels, reorder_rules,
  sales_daily, purchase_order_drafts, inbound_events, canonical_invoices, canonical_invoice_items,
  resolved_invoice_items, sync_results
  FROM groceryclaw_bootstrap_owner;
REVOKE INSERT, UPDATE ON tenants FROM groceryclaw_bootstrap_owner;
REVOKE SELECT, DELETE ON voice_audit_log FROM groceryclaw_bootstrap_owner;
REVOKE DELETE ON tenant_users, platform_users FROM groceryclaw_bootstrap_owner;

DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_clients;
DROP TABLE IF EXISTS sandbox_shops;
DROP TABLE IF EXISTS web_accounts;

COMMIT;
