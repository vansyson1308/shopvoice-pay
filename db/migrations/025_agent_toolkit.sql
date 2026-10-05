-- migrate:up
-- Migration 025: PayPal Agent Toolkit behind the policy layer.
--  * shipment_tracked: server code added delivery tracking to a PayPal capture
--    (toolkit create_shipment_tracking) after the goods arrived;
--  * sales_invoices: the shop's own catering invoices (toolkit create_invoice
--    and send_invoice), created only after the owner confirms a preview.
-- Rows are tenant-scoped (forced RLS) and never deleted by the runtime role.
BEGIN;

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN (
  'policy_evaluated', 'approval_requested', 'approved', 'declined', 'authorized', 'reauthorized',
  'captured', 'voided', 'refunded', 'payout_sent', 'payout_completed', 'failed', 'webhook_received',
  'cart_negotiated', 'supplier_ordered', 'shipment_tracked'
));

CREATE TABLE IF NOT EXISTS sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'paid', 'cancelled', 'failed')),
  customer_email TEXT NOT NULL CHECK (char_length(customer_email) BETWEEN 3 AND 254),
  customer_name TEXT,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_minor BIGINT NOT NULL CHECK (total_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note TEXT NOT NULL DEFAULT '',
  invoice_number TEXT NOT NULL,
  paypal_invoice_id TEXT,
  paypal_request_id TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'owner')),
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_sales_invoices_sent_has_paypal CHECK (status IN ('draft', 'failed') OR paypal_invoice_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_tenant_created ON sales_invoices (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoices_request ON sales_invoices (tenant_id, paypal_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoices_number ON sales_invoices (tenant_id, invoice_number);

ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_sales_invoices_app_user ON sales_invoices;
CREATE POLICY rls_sales_invoices_app_user ON sales_invoices
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
GRANT SELECT, INSERT, UPDATE ON sales_invoices TO groceryclaw_app_user;
-- The demo reset (sandbox_reset, SECURITY DEFINER) clears a shop's invoices.
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoices TO groceryclaw_bootstrap_owner;

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
  DELETE FROM sales_invoices WHERE tenant_id = p_tenant;
  PERFORM seed_sandbox_shop(p_tenant, v_user, p_catalogue, v_today, 'en');
  RETURN true;
END;
$$;

COMMIT;

-- migrate:down
BEGIN;

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

DROP TABLE IF EXISTS sales_invoices;

DELETE FROM payment_events WHERE kind = 'shipment_tracked';
ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN (
  'policy_evaluated', 'approval_requested', 'approved', 'declined', 'authorized', 'reauthorized',
  'captured', 'voided', 'refunded', 'payout_sent', 'payout_completed', 'failed', 'webhook_received',
  'cart_negotiated', 'supplier_ordered'
));

COMMIT;
