-- migrate:up
BEGIN;

CREATE TABLE IF NOT EXISTS mapping_dictionary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  alias_text TEXT NOT NULL,
  target_sku TEXT NOT NULL,
  confidence INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alias_text)
);

CREATE TABLE IF NOT EXISTS product_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sku TEXT NOT NULL,
  barcode TEXT,
  product_name TEXT NOT NULL,
  unit TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  multiplier NUMERIC(18,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_unit, to_unit)
);

CREATE TABLE IF NOT EXISTS resolved_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  canonical_invoice_id UUID NOT NULL REFERENCES canonical_invoices(id) ON DELETE CASCADE,
  canonical_item_id UUID NOT NULL REFERENCES canonical_invoice_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('resolved','unresolved')),
  resolved_sku TEXT,
  resolved_unit TEXT,
  quantity NUMERIC(18,3) NOT NULL,
  unresolved_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_item_id)
);

CREATE TABLE IF NOT EXISTS sync_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  canonical_invoice_id UUID NOT NULL REFERENCES canonical_invoices(id),
  external_system TEXT NOT NULL,
  external_reference_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mapping_dictionary_tenant_alias ON mapping_dictionary (tenant_id, alias_text);
CREATE INDEX IF NOT EXISTS idx_product_cache_tenant_sku ON product_cache (tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_resolved_invoice_items_tenant_invoice ON resolved_invoice_items (tenant_id, canonical_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sync_results_tenant_invoice ON sync_results (tenant_id, canonical_invoice_id);

ALTER TABLE mapping_dictionary ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolved_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_mapping_dictionary_app_user ON mapping_dictionary;
CREATE POLICY rls_mapping_dictionary_app_user ON mapping_dictionary
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_product_cache_app_user ON product_cache;
CREATE POLICY rls_product_cache_app_user ON product_cache
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_unit_conversions_app_user ON unit_conversions;
CREATE POLICY rls_unit_conversions_app_user ON unit_conversions
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_resolved_invoice_items_app_user ON resolved_invoice_items;
CREATE POLICY rls_resolved_invoice_items_app_user ON resolved_invoice_items
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_sync_results_app_user ON sync_results;
CREATE POLICY rls_sync_results_app_user ON sync_results
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON mapping_dictionary TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_cache TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON unit_conversions TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON resolved_invoice_items TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_results TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;
REVOKE SELECT, INSERT, UPDATE, DELETE ON sync_results FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON resolved_invoice_items FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON unit_conversions FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON product_cache FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON mapping_dictionary FROM groceryclaw_app_user;

DROP POLICY IF EXISTS rls_sync_results_app_user ON sync_results;
DROP POLICY IF EXISTS rls_resolved_invoice_items_app_user ON resolved_invoice_items;
DROP POLICY IF EXISTS rls_unit_conversions_app_user ON unit_conversions;
DROP POLICY IF EXISTS rls_product_cache_app_user ON product_cache;
DROP POLICY IF EXISTS rls_mapping_dictionary_app_user ON mapping_dictionary;

ALTER TABLE IF EXISTS sync_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS resolved_invoice_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS unit_conversions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS product_cache DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mapping_dictionary DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS sync_results;
DROP TABLE IF EXISTS resolved_invoice_items;
DROP TABLE IF EXISTS unit_conversions;
DROP TABLE IF EXISTS product_cache;
DROP TABLE IF EXISTS mapping_dictionary;
COMMIT;
