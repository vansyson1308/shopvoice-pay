-- migrate:up
BEGIN;

CREATE TABLE IF NOT EXISTS canonical_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  inbound_event_id UUID NOT NULL REFERENCES inbound_events(id),
  invoice_fingerprint TEXT NOT NULL,
  supplier_code TEXT,
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'VND',
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_fingerprint)
);

CREATE TABLE IF NOT EXISTS canonical_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  canonical_invoice_id UUID NOT NULL REFERENCES canonical_invoices(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  sku TEXT,
  product_name TEXT NOT NULL,
  quantity NUMERIC(18,3) NOT NULL,
  unit_price NUMERIC(18,2) NOT NULL,
  line_total NUMERIC(18,2) NOT NULL,
  uom TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_invoice_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_canonical_invoices_tenant_date
  ON canonical_invoices (tenant_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_invoice_items_tenant_invoice
  ON canonical_invoice_items (tenant_id, canonical_invoice_id);

ALTER TABLE canonical_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_invoice_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_canonical_invoices_app_user ON canonical_invoices;
CREATE POLICY rls_canonical_invoices_app_user ON canonical_invoices
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_canonical_invoice_items_app_user ON canonical_invoice_items;
CREATE POLICY rls_canonical_invoice_items_app_user ON canonical_invoice_items
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON canonical_invoices TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON canonical_invoice_items TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE SELECT, INSERT, UPDATE, DELETE ON canonical_invoice_items FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON canonical_invoices FROM groceryclaw_app_user;

DROP POLICY IF EXISTS rls_canonical_invoice_items_app_user ON canonical_invoice_items;
DROP POLICY IF EXISTS rls_canonical_invoices_app_user ON canonical_invoices;

ALTER TABLE IF EXISTS canonical_invoice_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS canonical_invoices DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS canonical_invoice_items;
DROP TABLE IF EXISTS canonical_invoices;

COMMIT;
