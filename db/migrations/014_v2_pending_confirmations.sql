-- Migration: 014_v2_pending_confirmations
-- Description: Add pending_confirmations table for AI product match confirmation flow
-- Date: 2026-03-28

-- ============================================================================
-- UP
-- ============================================================================

-- Table to track AI-suggested product matches awaiting user confirmation via Telegram
CREATE TABLE IF NOT EXISTS pending_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  canonical_invoice_id UUID NOT NULL,
  canonical_item_id UUID NOT NULL,
  platform_user_id TEXT NOT NULL,
  telegram_chat_id BIGINT NOT NULL,
  sent_message_id TEXT NOT NULL,
  invoice_product_name TEXT NOT NULL,
  suggested_sku TEXT NOT NULL,
  suggested_name TEXT NOT NULL,
  confidence INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (telegram_chat_id, sent_message_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_pc_user_pending
  ON pending_confirmations (tenant_id, platform_user_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pc_invoice
  ON pending_confirmations (canonical_invoice_id, status);

CREATE INDEX IF NOT EXISTS idx_pc_expiry
  ON pending_confirmations (status, expires_at)
  WHERE status = 'pending';

-- RLS
ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_confirmations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_pending_confirmations_app_user ON pending_confirmations;
CREATE POLICY rls_pending_confirmations_app_user ON pending_confirmations
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE ON pending_confirmations TO groceryclaw_app_user;

-- Extend resolved_invoice_items status to support 'pending_confirmation'
ALTER TABLE resolved_invoice_items
  DROP CONSTRAINT IF EXISTS resolved_invoice_items_status_check;
ALTER TABLE resolved_invoice_items
  ADD CONSTRAINT resolved_invoice_items_status_check
  CHECK (status IN ('resolved', 'unresolved', 'pending_confirmation'));

-- ============================================================================
-- DOWN
-- ============================================================================
-- ALTER TABLE resolved_invoice_items DROP CONSTRAINT IF EXISTS resolved_invoice_items_status_check;
-- ALTER TABLE resolved_invoice_items ADD CONSTRAINT resolved_invoice_items_status_check CHECK (status IN ('resolved', 'unresolved'));
-- DROP POLICY IF EXISTS rls_pending_confirmations_app_user ON pending_confirmations;
-- ALTER TABLE IF EXISTS pending_confirmations DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS pending_confirmations;
