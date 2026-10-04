-- migrate:up
-- Migration 019: ShopVoice Pay payments, spending policy, ledger and delivery matching.
-- Same tenant pattern as 017: ENABLE + FORCE row-level security, policy on
-- _rls_tenant_id(), grants to groceryclaw_app_user only. Money is integer minor
-- units plus an ISO 4217 code; never floats. The ledger's money invariants are
-- CHECK constraints so even a buggy caller cannot record an impossible state.
BEGIN;

-- Where a supplier gets paid (Payouts receiver; DECISIONS.md D1).
CREATE TABLE IF NOT EXISTS supplier_payees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code TEXT NOT NULL,
  paypal_email TEXT CHECK (paypal_email IS NULL OR paypal_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  paypal_merchant_id TEXT CHECK (paypal_merchant_id IS NULL OR paypal_merchant_id ~ '^[A-Z0-9]{8,20}$'),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, supplier_code),
  CHECK (paypal_email IS NOT NULL OR paypal_merchant_id IS NOT NULL)
);

-- One spending policy per shop. Enforced by the policy engine, never by the LLM.
CREATE TABLE IF NOT EXISTS spend_policies (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  per_order_autopay_max_minor BIGINT NOT NULL DEFAULT 10000 CHECK (per_order_autopay_max_minor >= 0),
  daily_max_minor BIGINT NOT NULL DEFAULT 50000 CHECK (daily_max_minor >= 0),
  weekly_max_minor BIGINT NOT NULL DEFAULT 150000 CHECK (weekly_max_minor >= 0),
  daily_hard_cap_minor BIGINT CHECK (daily_hard_cap_minor IS NULL OR daily_hard_cap_minor >= daily_max_minor),
  weekly_hard_cap_minor BIGINT CHECK (weekly_hard_cap_minor IS NULL OR weekly_hard_cap_minor >= weekly_max_minor),
  allow_listed_supplier_codes TEXT[] NOT NULL DEFAULT '{}',
  price_jump_pct INT NOT NULL DEFAULT 20 CHECK (price_jump_pct BETWEEN 1 AND 500),
  substitution_tolerance_pct INT NOT NULL DEFAULT 5 CHECK (substitution_tolerance_pct BETWEEN 0 AND 50),
  quantity_spike_multiplier INT NOT NULL DEFAULT 3 CHECK (quantity_spike_multiplier BETWEEN 2 AND 20),
  require_delivery_check BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT NOT NULL DEFAULT 'seed' CHECK (updated_by IN ('owner', 'seed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The owner's vaulted PayPal account. The vault id (and the pending setup
-- token) live only inside the envelope-encrypted payload; payer_label is a
-- masked email safe to show in the UI.
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'paypal' CHECK (provider = 'paypal'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'failed')),
  encrypted_dek BYTEA NOT NULL,
  dek_nonce BYTEA NOT NULL,
  encrypted_value BYTEA NOT NULL,
  value_nonce BYTEA NOT NULL,
  payer_label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_methods_one_active ON payment_methods (tenant_id) WHERE status = 'active';

-- Money on drafts: integer minor units + currency (the legacy total_vnd stays for imported tools).
ALTER TABLE purchase_order_drafts ADD COLUMN IF NOT EXISTS currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE purchase_order_drafts ADD COLUMN IF NOT EXISTS total_minor BIGINT CHECK (total_minor IS NULL OR total_minor >= 0);

-- Supplier price list history: the 30-day baseline for the price-jump rule.
CREATE TABLE IF NOT EXISTS supplier_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit_cost_minor BIGINT NOT NULL CHECK (unit_cost_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  observed_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, supplier_code, sku, observed_on)
);

-- The ledger: one row per supplier payment, its money state and why the agent did it.
CREATE TABLE IF NOT EXISTS supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_id UUID REFERENCES purchase_order_drafts(id) ON DELETE SET NULL,
  supplier_code TEXT NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_requested_minor BIGINT NOT NULL CHECK (amount_requested_minor > 0),
  amount_authorized_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_authorized_minor >= 0),
  amount_captured_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_captured_minor >= 0),
  amount_voided_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_voided_minor >= 0),
  amount_refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  amount_settled_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_settled_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'authorized', 'partially_captured', 'captured', 'voided', 'refunded', 'failed', 'blocked')),
  decision TEXT NOT NULL CHECK (decision IN ('autopay', 'step_up', 'blocked')),
  decision_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  lines_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'owner')),
  approved_by TEXT CHECK (approved_by IS NULL OR approved_by IN ('owner_voice', 'owner_tap', 'owner_paypal')),
  -- PayPal identifiers stay server-side; tools never return them to the model.
  paypal_order_id TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_ids TEXT[] NOT NULL DEFAULT '{}',
  authorization_expires_at TIMESTAMPTZ,
  honor_period_ends_at TIMESTAMPTZ,
  -- Step-up: only the SHA-256 of the approval token is stored.
  approval_token_hash TEXT CHECK (approval_token_hash IS NULL OR approval_token_hash ~ '^[0-9a-f]{64}$'),
  approval_expires_at TIMESTAMPTZ,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_supplier_payments_capture_void_le_authorized CHECK (amount_captured_minor + amount_voided_minor <= amount_authorized_minor),
  CONSTRAINT ck_supplier_payments_refund_le_captured CHECK (amount_refunded_minor <= amount_captured_minor),
  CONSTRAINT ck_supplier_payments_settled_le_net CHECK (amount_settled_minor <= amount_captured_minor),
  CONSTRAINT ck_supplier_payments_authorized_le_requested CHECK (amount_authorized_minor <= amount_requested_minor)
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant_created ON supplier_payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant_status ON supplier_payments (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payments_authorization ON supplier_payments (paypal_authorization_id) WHERE paypal_authorization_id IS NOT NULL;

-- Append-only event log: one row per decision and per PayPal call.
CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'policy_evaluated', 'approval_requested', 'approved', 'declined', 'authorized', 'reauthorized',
    'captured', 'voided', 'refunded', 'payout_sent', 'payout_completed', 'failed', 'webhook_received'
  )),
  amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'system', 'paypal')),
  reason TEXT NOT NULL DEFAULT '',
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  paypal_request_id TEXT,
  paypal_resource_id TEXT,
  paypal_debug_id TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events (payment_id, created_at);
-- A PayPal-Request-Id identifies one money movement; recording it twice is a bug.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_events_request ON payment_events (tenant_id, paypal_request_id) WHERE paypal_request_id IS NOT NULL;

-- Deliveries and the 3-way match (PO vs received vs invoice).
CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('voice', 'invoice_photo', 'console')),
  received_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT NOT NULL CHECK (outcome IN ('full', 'partial', 'hold', 'none')),
  delivered_value_minor BIGINT NOT NULL CHECK (delivered_value_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_payment ON deliveries (payment_id);

CREATE TABLE IF NOT EXISTS invoice_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  -- Extracted from an untrusted invoice image; stored as data, never as instructions.
  extracted_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  po_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  result TEXT NOT NULL CHECK (result IN ('match', 'short', 'over', 'price_mismatch', 'mismatch')),
  variance_minor BIGINT NOT NULL DEFAULT 0,
  extractor TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE supplier_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_matches ENABLE ROW LEVEL SECURITY;

ALTER TABLE supplier_payees FORCE ROW LEVEL SECURITY;
ALTER TABLE spend_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_price_history FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_matches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_supplier_payees_app_user ON supplier_payees;
CREATE POLICY rls_supplier_payees_app_user ON supplier_payees
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_spend_policies_app_user ON spend_policies;
CREATE POLICY rls_spend_policies_app_user ON spend_policies
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_payment_methods_app_user ON payment_methods;
CREATE POLICY rls_payment_methods_app_user ON payment_methods
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_supplier_price_history_app_user ON supplier_price_history;
CREATE POLICY rls_supplier_price_history_app_user ON supplier_price_history
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_supplier_payments_app_user ON supplier_payments;
CREATE POLICY rls_supplier_payments_app_user ON supplier_payments
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_payment_events_app_user ON payment_events;
CREATE POLICY rls_payment_events_app_user ON payment_events
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_deliveries_app_user ON deliveries;
CREATE POLICY rls_deliveries_app_user ON deliveries
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());
DROP POLICY IF EXISTS rls_invoice_matches_app_user ON invoice_matches;
CREATE POLICY rls_invoice_matches_app_user ON invoice_matches
  USING (tenant_id = _rls_tenant_id()) WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_payees TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE ON spend_policies TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE ON payment_methods TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE ON supplier_price_history TO groceryclaw_app_user;
-- Ledger rows are never deleted by the runtime role.
GRANT SELECT, INSERT, UPDATE ON supplier_payments TO groceryclaw_app_user;
-- The event log and match records are append-only for the runtime role.
GRANT SELECT, INSERT ON payment_events TO groceryclaw_app_user;
GRANT SELECT, INSERT ON deliveries TO groceryclaw_app_user;
GRANT SELECT, INSERT ON invoice_matches TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE SELECT, INSERT ON invoice_matches FROM groceryclaw_app_user;
REVOKE SELECT, INSERT ON deliveries FROM groceryclaw_app_user;
REVOKE SELECT, INSERT ON payment_events FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE ON supplier_payments FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE ON supplier_price_history FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE ON payment_methods FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE ON spend_policies FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON supplier_payees FROM groceryclaw_app_user;

DROP TABLE IF EXISTS invoice_matches;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS supplier_payments;
DROP TABLE IF EXISTS supplier_price_history;
DROP TABLE IF EXISTS payment_methods;
DROP TABLE IF EXISTS spend_policies;
DROP TABLE IF EXISTS supplier_payees;

ALTER TABLE purchase_order_drafts DROP COLUMN IF EXISTS total_minor;
ALTER TABLE purchase_order_drafts DROP COLUMN IF EXISTS currency;

COMMIT;
