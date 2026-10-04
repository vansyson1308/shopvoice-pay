-- migrate:up
-- Migration 022: a PayPal webhook arrives with no tenant context. The event
-- carries our payment id (custom_id on the purchase unit); this function maps
-- that id to its tenant and nothing else, so the webhook handler can open a
-- tenant-scoped transaction and re-read PayPal's state for that payment.
-- It never returns payment data: RLS still guards every read after it.
BEGIN;

CREATE OR REPLACE FUNCTION resolve_payment_tenant(p_payment_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.tenant_id
    FROM supplier_payments p
    JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
   WHERE p.id = p_payment_id;
$$;

GRANT SELECT ON supplier_payments TO groceryclaw_bootstrap_owner;
ALTER FUNCTION resolve_payment_tenant(UUID) OWNER TO groceryclaw_bootstrap_owner;
REVOKE ALL ON FUNCTION resolve_payment_tenant(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_payment_tenant(UUID) TO groceryclaw_app_user;

COMMIT;

-- migrate:down
BEGIN;

REVOKE EXECUTE ON FUNCTION resolve_payment_tenant(UUID) FROM groceryclaw_app_user;
DROP FUNCTION IF EXISTS resolve_payment_tenant(UUID);

COMMIT;
