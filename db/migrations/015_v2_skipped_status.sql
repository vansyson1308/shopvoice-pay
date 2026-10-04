-- Migration 015: Add 'skipped' status for promotional/gift items
-- Users can reply "3" or "Bo qua" to skip items they don't want imported

-- Extend resolved_invoice_items status CHECK to include 'skipped'
ALTER TABLE resolved_invoice_items
  DROP CONSTRAINT IF EXISTS resolved_invoice_items_status_check;
ALTER TABLE resolved_invoice_items
  ADD CONSTRAINT resolved_invoice_items_status_check
  CHECK (status IN ('resolved', 'unresolved', 'pending_confirmation', 'skipped'));

-- Extend pending_confirmations status CHECK to include 'skipped'
ALTER TABLE pending_confirmations
  DROP CONSTRAINT IF EXISTS pending_confirmations_status_check;
ALTER TABLE pending_confirmations
  ADD CONSTRAINT pending_confirmations_status_check
  CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired', 'skipped'));

---- rollback
ALTER TABLE resolved_invoice_items
  DROP CONSTRAINT IF EXISTS resolved_invoice_items_status_check;
ALTER TABLE resolved_invoice_items
  ADD CONSTRAINT resolved_invoice_items_status_check
  CHECK (status IN ('resolved', 'unresolved', 'pending_confirmation'));

ALTER TABLE pending_confirmations
  DROP CONSTRAINT IF EXISTS pending_confirmations_status_check;
ALTER TABLE pending_confirmations
  ADD CONSTRAINT pending_confirmations_status_check
  CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired'));
