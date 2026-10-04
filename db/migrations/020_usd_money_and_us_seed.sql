-- migrate:up
-- Migration 020: money is integer minor units + an ISO currency everywhere
-- (the imported tables stored whole Vietnamese dong), the demo shop is a US
-- store in America/New_York, and seed_sandbox_shop() also seeds the ShopVoice
-- Pay tables (spending policy, payees, supplier price history, past orders).
-- The one function seeds both the demo tenant (db/seed/002) and every
-- "Try the demo" sign-up, so they cannot drift apart.
BEGIN;

ALTER TABLE reorder_rules RENAME COLUMN unit_cost_vnd TO unit_cost_minor;
ALTER TABLE sales_daily RENAME COLUMN revenue_vnd TO revenue_minor;
ALTER TABLE sales_daily DROP COLUMN IF EXISTS revenue_display;
-- 019 added a nullable total_minor beside total_vnd; keep one column.
ALTER TABLE purchase_order_drafts DROP COLUMN IF EXISTS total_minor;
ALTER TABLE purchase_order_drafts RENAME COLUMN total_vnd TO total_minor;
UPDATE purchase_order_drafts SET currency = 'USD' WHERE currency IS NULL;
ALTER TABLE purchase_order_drafts ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE purchase_order_drafts ALTER COLUMN currency SET NOT NULL;
ALTER TABLE shop_profiles RENAME COLUMN vnd_per_display_unit TO minor_per_unit;
ALTER TABLE shop_profiles ALTER COLUMN display_currency SET DEFAULT 'USD';
ALTER TABLE shop_profiles ALTER COLUMN minor_per_unit SET DEFAULT 100;
ALTER TABLE shop_profiles ALTER COLUMN timezone SET DEFAULT 'America/New_York';

-- The seed functions run as the BYPASSRLS bootstrap owner (as in 018).
GRANT SELECT, INSERT, UPDATE, DELETE ON spend_policies, supplier_payees, supplier_price_history, supplier_payments,
  payment_events, deliveries, invoice_matches
  TO groceryclaw_bootstrap_owner;

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
  v_tz TEXT := COALESCE(v_profile->>'timezone', 'America/New_York');
  v_policy JSONB := p_catalogue->'policy';
  v_inv JSONB;
  v_item JSONB;
  v_order JSONB;
  v_event UUID;
  v_invoice UUID;
  v_item_id UUID;
  v_draft UUID;
  v_payment UUID;
  v_line INT;
  v_total BIGINT;
  v_when TIMESTAMPTZ;
BEGIN
  -- Ledger first (events, deliveries and matches cascade from payments).
  DELETE FROM supplier_payments WHERE tenant_id = p_tenant;
  DELETE FROM supplier_price_history WHERE tenant_id = p_tenant;
  DELETE FROM supplier_payees WHERE tenant_id = p_tenant;
  DELETE FROM spend_policies WHERE tenant_id = p_tenant;
  -- A connected PayPal account (payment_methods) survives a demo reset.
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

  INSERT INTO shop_profiles (tenant_id, shop_name, display_currency, minor_per_unit, timezone, locale)
  VALUES (p_tenant, v_profile->>'shop_name', COALESCE(v_profile->>'display_currency', 'USD'),
          COALESCE((v_profile->>'minor_per_unit')::numeric, 100), v_tz, COALESCE(v_profile->>'locale', 'en-US'));

  INSERT INTO suppliers (tenant_id, supplier_code, name, phone, default_lead_time_days)
  SELECT p_tenant, s.code, s.name, s.phone, s.lead
    FROM jsonb_to_recordset(p_catalogue->'suppliers') AS s(code TEXT, name TEXT, phone TEXT, lead INT);

  CREATE TEMP TABLE IF NOT EXISTS sandbox_products (
    sku TEXT, name TEXT, unit TEXT, barcode TEXT, price BIGINT, unit_cost BIGINT, base10 NUMERIC, pack NUMERIC,
    supplier TEXT, lead INT, min_qty NUMERIC, reorder_qty NUMERIC, on_hand NUMERIC, noise INT[]
  ) ON COMMIT DROP;
  TRUNCATE sandbox_products;
  INSERT INTO sandbox_products
  SELECT p.sku, p.name, p.unit, p.barcode, p.price, p.unit_cost, p.base10, p.pack, p.supplier, p.lead,
         p.min_qty, p.reorder_qty, p.on_hand,
         ARRAY(SELECT e::int FROM jsonb_array_elements_text(p.noise) WITH ORDINALITY AS x(e, i) ORDER BY i)
    FROM jsonb_to_recordset(p_catalogue->'products') AS p(
      sku TEXT, name TEXT, unit TEXT, barcode TEXT, price BIGINT, unit_cost BIGINT, base10 NUMERIC, pack NUMERIC,
      supplier TEXT, lead INT, min_qty NUMERIC, reorder_qty NUMERIC, on_hand NUMERIC, noise JSONB);

  INSERT INTO product_cache (tenant_id, sku, barcode, product_name, unit, active, base_price)
  SELECT p_tenant, sku, barcode, name, unit, true, price FROM sandbox_products;

  INSERT INTO stock_levels (tenant_id, sku, on_hand_qty, unit, source, updated_at)
  SELECT p_tenant, sku, on_hand, unit, 'seed', now() FROM sandbox_products;

  INSERT INTO reorder_rules (tenant_id, sku, min_qty, reorder_qty, pack_size, unit_cost_minor, preferred_supplier_code, lead_time_days)
  SELECT p_tenant, sku, min_qty, reorder_qty, pack, unit_cost, supplier, lead FROM sandbox_products;

  -- qty = round(base10/10 x weekday multiplier x noise% x today fraction); revenue in cents.
  INSERT INTO sales_daily (tenant_id, sale_date, sku, qty_sold, revenue_minor)
  SELECT p_tenant, sale_date, sku, qty, qty * price
    FROM (
      SELECT p_anchor - (v_days - n.idx)::int AS sale_date, p.sku, p.price,
             GREATEST(0, round(p.base10 / 10.0
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
    VALUES (v_event, p_tenant, p_user, 'sandbox-' || (v_inv->>'number') || '-' || p_tenant::text, 'image', '{"source":"sandbox_seed"}'::jsonb, 'completed');
    INSERT INTO canonical_invoices (id, tenant_id, inbound_event_id, invoice_fingerprint, supplier_code, invoice_number,
                                    invoice_date, currency, subtotal, total, created_at)
    VALUES (v_invoice, p_tenant, v_event, 'sandbox-' || (v_inv->>'number'), v_inv->>'supplier', v_inv->>'number',
            p_anchor - (v_inv->>'days_ago')::int, 'USD', v_total, v_total,
            ((p_anchor - (v_inv->>'days_ago')::int) + time '08:30') AT TIME ZONE v_tz);
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
      VALUES (p_tenant, v_invoice, 'kiotviet', 'DEMO-RECORDED', 'success');
    END IF;
  END LOOP;

  -- ShopVoice Pay: the owner's spending rules.
  IF v_policy IS NOT NULL THEN
    INSERT INTO spend_policies (tenant_id, currency, per_order_autopay_max_minor, daily_max_minor, weekly_max_minor,
                                daily_hard_cap_minor, weekly_hard_cap_minor, allow_listed_supplier_codes, price_jump_pct,
                                substitution_tolerance_pct, quantity_spike_multiplier, require_delivery_check, updated_by)
    VALUES (p_tenant, 'USD', (v_policy->>'per_order_autopay_max_minor')::bigint, (v_policy->>'daily_max_minor')::bigint,
            (v_policy->>'weekly_max_minor')::bigint, (v_policy->>'daily_hard_cap_minor')::bigint,
            (v_policy->>'weekly_hard_cap_minor')::bigint,
            ARRAY(SELECT jsonb_array_elements_text(v_policy->'allow_listed')),
            (v_policy->>'price_jump_pct')::int, (v_policy->>'substitution_tolerance_pct')::int,
            (v_policy->>'quantity_spike_multiplier')::int, true, 'seed');
  END IF;

  INSERT INTO supplier_payees (tenant_id, supplier_code, paypal_email, currency, verified, verified_at)
  SELECT p_tenant, x.supplier, x.email, 'USD', x.verified, CASE WHEN x.verified THEN now() END
    FROM jsonb_to_recordset(COALESCE(p_catalogue->'payees', '[]'::jsonb)) AS x(supplier TEXT, email TEXT, verified BOOLEAN);

  INSERT INTO supplier_price_history (tenant_id, supplier_code, sku, unit_cost_minor, currency, observed_on)
  SELECT p_tenant, x.supplier, x.sku, x.unit_cost, 'USD', p_anchor - x.days_ago
    FROM jsonb_to_recordset(COALESCE(p_catalogue->'prices', '[]'::jsonb)) AS x(supplier TEXT, sku TEXT, unit_cost BIGINT, days_ago INT);

  -- Past orders: confirmed drafts (the "usual quantity" baseline) and their
  -- completed ledger rows. They are seeded history, not PayPal transactions,
  -- and say so in the ledger.
  FOR v_order IN SELECT * FROM jsonb_array_elements(COALESCE(p_catalogue->'past_orders', '[]'::jsonb)) LOOP
    v_when := ((p_anchor - (v_order->>'days_ago')::int) + time '12:00') AT TIME ZONE v_tz;
    v_total := (v_order->>'qty')::bigint * (v_order->>'unit_cost')::bigint;
    INSERT INTO purchase_order_drafts (tenant_id, supplier_code, lines, total_minor, currency, status, created_via,
                                       expires_at, confirmed_at, created_at, updated_at)
    VALUES (p_tenant, v_order->>'supplier',
            jsonb_build_array(jsonb_build_object('sku', v_order->>'sku', 'name', v_order->>'name', 'unit', v_order->>'unit',
                                                 'qty', (v_order->>'qty')::int, 'unitCostMinor', (v_order->>'unit_cost')::bigint)),
            v_total, 'USD', 'confirmed', 'manual', v_when + interval '5 minutes', v_when, v_when, v_when)
    RETURNING id INTO v_draft;
    INSERT INTO supplier_payments (tenant_id, draft_id, supplier_code, currency, amount_requested_minor, amount_authorized_minor,
                                   amount_captured_minor, amount_settled_minor, status, decision, decision_reasons,
                                   lines_fingerprint, lines, created_by, correlation_id, created_at, updated_at)
    VALUES (p_tenant, v_draft, v_order->>'supplier', 'USD', v_total, v_total, v_total, v_total, 'captured', 'autopay',
            '[{"code":"within_policy","effect":"info","text":"Seeded order history (no PayPal transaction)."}]'::jsonb,
            (v_order->>'supplier') || '|' || (v_order->>'sku') || 'x' || (v_order->>'qty'),
            jsonb_build_array(jsonb_build_object('sku', v_order->>'sku', 'name', v_order->>'name',
                                                 'qty', (v_order->>'qty')::int, 'unitCostMinor', (v_order->>'unit_cost')::bigint)),
            'agent', 'seed', v_when, v_when)
    RETURNING id INTO v_payment;
    INSERT INTO payment_events (tenant_id, payment_id, kind, amount_minor, currency, actor, reason, correlation_id, created_at)
    VALUES (p_tenant, v_payment, 'captured', v_total, 'USD', 'system', 'Seeded order history (no PayPal transaction)', 'seed', v_when);
  END LOOP;
END;
$$;

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
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  INSERT INTO tenants (id, name, status, processing_mode)
  VALUES (v_tenant, COALESCE(p_catalogue->'profiles'->'en'->>'shop_name', 'Your demo shop (sample data)'), 'active', 'v2');

  INSERT INTO platform_users (platform_user_id, display_name, platform)
  VALUES ('web:' || v_account::text, 'ShopVoice web account', 'telegram')
  RETURNING id INTO v_user;

  INSERT INTO tenant_users (tenant_id, user_id, role, status)
  VALUES (v_tenant, v_user, 'owner', 'active');

  INSERT INTO web_accounts (id, email, password_hash, tenant_id, sandbox_tenant_id, platform_user_id, locale, is_sandbox)
  VALUES (v_account, lower(p_email), p_password_hash, v_tenant, v_tenant, v_user, p_locale, true);

  INSERT INTO sandbox_shops (tenant_id, seeded_on, locale) VALUES (v_tenant, v_today, p_locale);
  PERFORM seed_sandbox_shop(v_tenant, v_user, p_catalogue, v_today, 'en');

  RETURN QUERY SELECT v_account, v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION sandbox_refresh(p_tenant UUID, p_catalogue JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
  v_user UUID;
BEGIN
  UPDATE sandbox_shops SET seeded_on = v_today
   WHERE tenant_id = p_tenant AND seeded_on < v_today;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT platform_user_id INTO v_user FROM web_accounts WHERE sandbox_tenant_id = p_tenant LIMIT 1;
  PERFORM seed_sandbox_shop(p_tenant, v_user, p_catalogue, v_today, 'en');
  RETURN true;
END;
$$;

ALTER FUNCTION seed_sandbox_shop(UUID, UUID, JSONB, DATE, TEXT) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION web_account_create(TEXT, TEXT, TEXT, JSONB) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION sandbox_refresh(UUID, JSONB) OWNER TO groceryclaw_bootstrap_owner;

COMMIT;

-- migrate:down
BEGIN;
-- The pre-020 function bodies live in 018; re-apply 018's up section after
-- this rollback if the old (VND) seed is needed. Column names revert here.
ALTER TABLE shop_profiles RENAME COLUMN minor_per_unit TO vnd_per_display_unit;
ALTER TABLE shop_profiles ALTER COLUMN display_currency SET DEFAULT 'VND';
ALTER TABLE shop_profiles ALTER COLUMN vnd_per_display_unit SET DEFAULT 1;
ALTER TABLE shop_profiles ALTER COLUMN timezone SET DEFAULT 'Asia/Ho_Chi_Minh';
ALTER TABLE purchase_order_drafts ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE purchase_order_drafts ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE purchase_order_drafts RENAME COLUMN total_minor TO total_vnd;
ALTER TABLE purchase_order_drafts ADD COLUMN IF NOT EXISTS total_minor BIGINT CHECK (total_minor IS NULL OR total_minor >= 0);
ALTER TABLE sales_daily ADD COLUMN IF NOT EXISTS revenue_display NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_daily RENAME COLUMN revenue_minor TO revenue_vnd;
ALTER TABLE reorder_rules RENAME COLUMN unit_cost_minor TO unit_cost_vnd;
REVOKE SELECT, INSERT, UPDATE, DELETE ON spend_policies, supplier_payees, supplier_price_history, supplier_payments,
  payment_events, deliveries, invoice_matches
  FROM groceryclaw_bootstrap_owner;
COMMIT;
