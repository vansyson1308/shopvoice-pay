-- migrate:up
-- Migration 021: approvals from MCP clients and one live payment per draft.
--  * approved_by gains 'owner_elicitation': the owner approved in their MCP
--    client's own confirmation form (MCP elicitation), outside the model.
--  * A purchase-order draft can back at most one payment that is not
--    'failed', so confirming the same drafts twice can never pay twice.
BEGIN;

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_approved_by_check;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_approved_by_check
  CHECK (approved_by IS NULL OR approved_by IN ('owner_voice', 'owner_tap', 'owner_paypal', 'owner_elicitation'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payments_live_draft
  ON supplier_payments (tenant_id, draft_id)
  WHERE draft_id IS NOT NULL AND status <> 'failed';

COMMIT;

-- migrate:down
BEGIN;

DROP INDEX IF EXISTS uq_supplier_payments_live_draft;
UPDATE supplier_payments SET approved_by = 'owner_tap' WHERE approved_by = 'owner_elicitation';
ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_approved_by_check;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_approved_by_check
  CHECK (approved_by IS NULL OR approved_by IN ('owner_voice', 'owner_tap', 'owner_paypal'));

COMMIT;
