-- migrate:up
-- Phase 2: Migrate from Zalo-centric to platform-agnostic schema for Telegram support.
-- Changes:
--   1. Rename zalo_users -> platform_users, add platform + telegram_chat_id columns
--   2. Rename zalo_user_id -> user_id in tenant_users, inbound_events, pending_notifications
--   3. Rename zalo_msg_id -> message_id in inbound_events
--   4. Recreate RLS policies, indexes, bootstrap functions for new names
--   5. Add employee_permissions table with RLS
--   6. Update secret_versions to accept kiotviet_client_credentials
--   7. FORCE RLS on new/renamed tables

BEGIN;

-- ============================================================
-- STEP 1: Drop old bootstrap functions (they reference zalo_users)
-- ============================================================

-- Revoke from all roles before dropping
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'resolve_membership_by_platform_user_id') THEN
    REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM groceryclaw_app_user;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM app_user;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'consume_invite_code') THEN
    REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT) FROM groceryclaw_app_user;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT) FROM app_user;
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS resolve_membership_by_platform_user_id(TEXT);
DROP FUNCTION IF EXISTS consume_invite_code(TEXT, TEXT);

-- ============================================================
-- STEP 2: Drop old RLS policies that reference zalo_users/zalo_user_id
-- ============================================================

DROP POLICY IF EXISTS rls_zalo_users_app_user ON zalo_users;
DROP POLICY IF EXISTS rls_tenant_users_app_user ON tenant_users;
DROP POLICY IF EXISTS rls_pending_notifications_app_user ON pending_notifications;
DROP POLICY IF EXISTS rls_inbound_events_app_user ON inbound_events;

-- ============================================================
-- STEP 3: Drop old indexes that reference zalo columns
-- ============================================================

DROP INDEX IF EXISTS idx_tenant_users_zalo;
DROP INDEX IF EXISTS idx_pending_user;

-- ============================================================
-- STEP 4: Rename zalo_users -> platform_users
-- ============================================================

ALTER TABLE zalo_users RENAME TO platform_users;

-- Add new columns for platform-agnostic support
ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram', 'zalo'));

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

-- Drop old unique index on platform_user_id (was UNIQUE in column def)
-- and create new composite unique on (platform, platform_user_id)
ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS zalo_users_platform_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_platform_uid
  ON platform_users (platform, platform_user_id);

-- ============================================================
-- STEP 5: Rename FK columns across tables
-- ============================================================

-- tenant_users: zalo_user_id -> user_id
ALTER TABLE tenant_users RENAME COLUMN zalo_user_id TO user_id;

-- inbound_events: zalo_user_id -> user_id, zalo_msg_id -> message_id
ALTER TABLE inbound_events RENAME COLUMN zalo_user_id TO user_id;
ALTER TABLE inbound_events RENAME COLUMN zalo_msg_id TO message_id;

-- pending_notifications: zalo_user_id -> user_id
ALTER TABLE pending_notifications RENAME COLUMN zalo_user_id TO user_id;

-- NOTE: invite_codes.used_by FK still points to platform_users(id), no rename needed.
-- The REFERENCES zalo_users(id) constraint auto-follows the table rename.

-- ============================================================
-- STEP 6: Recreate indexes with new column names
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users (user_id);
CREATE INDEX IF NOT EXISTS idx_pending_user_new ON pending_notifications (user_id, status)
  WHERE status = 'pending';

-- ============================================================
-- STEP 7: Recreate RLS policies for renamed table/columns
-- ============================================================

-- platform_users: scoped through tenant membership (same logic, new names)
CREATE POLICY rls_platform_users_app_user ON platform_users
  FOR ALL TO groceryclaw_app_user
  USING (
    EXISTS (
      SELECT 1
      FROM tenant_users tu
      WHERE tu.user_id = platform_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM tenant_users tu
      WHERE tu.user_id = platform_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  );

-- tenant_users: tenant_id scoped (same policy, recreated)
CREATE POLICY rls_tenant_users_app_user ON tenant_users
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

-- inbound_events: tenant_id scoped (same policy, recreated)
CREATE POLICY rls_inbound_events_app_user ON inbound_events
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

-- pending_notifications: tenant_id scoped (same policy, recreated)
CREATE POLICY rls_pending_notifications_app_user ON pending_notifications
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

-- ============================================================
-- STEP 8: FORCE RLS on renamed table
-- ============================================================

ALTER TABLE platform_users FORCE ROW LEVEL SECURITY;

-- ============================================================
-- STEP 9: Create employee_permissions table
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tenant_user_id UUID NOT NULL REFERENCES tenant_users(id),
  permission_type TEXT NOT NULL
    CHECK (permission_type IN ('product_code', 'category', 'all')),
  permission_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tenant_user_id, permission_type, permission_value)
);

CREATE INDEX IF NOT EXISTS idx_employee_permissions_tenant_user
  ON employee_permissions (tenant_id, tenant_user_id);

ALTER TABLE employee_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_employee_permissions_app_user ON employee_permissions
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_permissions TO groceryclaw_app_user;

-- ============================================================
-- STEP 10: Update secret_versions CHECK constraint to allow new types
-- ============================================================

ALTER TABLE secret_versions DROP CONSTRAINT IF EXISTS secret_versions_secret_type_check;
ALTER TABLE secret_versions
  ADD CONSTRAINT secret_versions_secret_type_check
  CHECK (secret_type IN ('kiotviet_token', 'kiotviet_client_credentials'));

-- ============================================================
-- STEP 11: Update bootstrap_owner grants for renamed table
-- ============================================================

REVOKE ALL ON platform_users FROM groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, UPDATE ON platform_users TO groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, UPDATE ON employee_permissions TO groceryclaw_bootstrap_owner;

-- ============================================================
-- STEP 12: Recreate bootstrap functions with new table/column names
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_membership_by_platform_user_id(
  p_platform_user_id TEXT
)
RETURNS TABLE (
  tenant_id UUID,
  tenant_user_id UUID,
  role TEXT,
  status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tu.tenant_id,
    tu.id AS tenant_user_id,
    tu.role,
    tu.status
  FROM platform_users pu
  JOIN tenant_users tu ON tu.user_id = pu.id
  WHERE pu.platform_user_id = p_platform_user_id
    AND tu.status = 'active'
  ORDER BY tu.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION consume_invite_code(
  p_platform_user_id TEXT,
  p_code TEXT,
  p_telegram_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  ok BOOLEAN,
  tenant_id UUID,
  role_assigned TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_normalized TEXT;
  v_pepper_b64 TEXT;
  v_pepper BYTEA;
  v_code_hash BYTEA;
  v_user_id UUID;
  v_user_lockout_until TIMESTAMPTZ;
  v_invite RECORD;
  v_existing_membership_tenant UUID;
BEGIN
  -- Ensure user exists and read lockout state
  INSERT INTO platform_users (platform_user_id, platform, telegram_chat_id, last_interaction_at)
  VALUES (p_platform_user_id, 'telegram', p_telegram_chat_id, v_now)
  ON CONFLICT (platform, platform_user_id)
  DO UPDATE SET
    updated_at = v_now,
    telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, platform_users.telegram_chat_id)
  RETURNING id, invite_lockout_until INTO v_user_id, v_user_lockout_until;

  -- Per-user lockout check
  IF v_user_lockout_until IS NOT NULL AND v_user_lockout_until > v_now THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Normalize: trim, remove spaces/hyphens, uppercase, strict charset/length
  v_normalized := upper(regexp_replace(trim(p_code), '[ -]', '', 'g'));
  IF v_normalized !~ '^[A-Z0-9]{6,32}$' THEN
    UPDATE platform_users
    SET
      invite_attempt_count = CASE
        WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
        ELSE invite_attempt_count + 1
      END,
      invite_lockout_until = CASE
        WHEN (
          CASE
            WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
            ELSE invite_attempt_count + 1
          END
        ) >= 5 THEN v_now + INTERVAL '60 minutes'
        ELSE invite_lockout_until
      END,
      invite_last_attempt_at = v_now
    WHERE id = v_user_id;

    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Resolve canonical pepper from base64 setting
  v_pepper_b64 := current_setting('app.invite_pepper_b64', true);

  IF v_pepper_b64 IS NOT NULL AND btrim(v_pepper_b64) <> '' THEN
    v_pepper := decode(v_pepper_b64, 'base64');
  ELSE
    RAISE EXCEPTION 'invite pepper is not configured';
  END IF;

  IF v_pepper IS NULL OR length(v_pepper) < 8 THEN
    RAISE EXCEPTION 'invite pepper is invalid';
  END IF;

  v_code_hash := digest(v_pepper || convert_to(v_normalized, 'UTF8'), 'sha256');

  -- one-user-one-tenant invariant (V2 basic)
  SELECT tu.tenant_id
  INTO v_existing_membership_tenant
  FROM tenant_users tu
  WHERE tu.user_id = v_user_id
    AND tu.status = 'active'
  LIMIT 1;

  IF v_existing_membership_tenant IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Lock active invite candidate row for concurrency safety
  SELECT ic.*
  INTO v_invite
  FROM invite_codes ic
  WHERE ic.code_hash = v_code_hash
    AND ic.status = 'active'
  ORDER BY ic.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_invite.id IS NULL THEN
    -- unknown or concurrently locked code: only per-user attempt tracking
    UPDATE platform_users
    SET
      invite_attempt_count = CASE
        WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
        ELSE invite_attempt_count + 1
      END,
      invite_lockout_until = CASE
        WHEN (
          CASE
            WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
            ELSE invite_attempt_count + 1
          END
        ) >= 5 THEN v_now + INTERVAL '60 minutes'
        ELSE invite_lockout_until
      END,
      invite_last_attempt_at = v_now
    WHERE id = v_user_id;

    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Found invite but ineligible
  IF v_invite.expires_at <= v_now
     OR v_invite.status <> 'active'
     OR (v_invite.lockout_until IS NOT NULL AND v_invite.lockout_until > v_now)
  THEN
    UPDATE invite_codes
    SET
      attempt_count = CASE
        WHEN last_attempt_at IS NULL OR last_attempt_at < v_now - INTERVAL '15 minutes' THEN 1
        ELSE attempt_count + 1
      END,
      lockout_until = CASE
        WHEN (
          CASE
            WHEN last_attempt_at IS NULL OR last_attempt_at < v_now - INTERVAL '15 minutes' THEN 1
            ELSE attempt_count + 1
          END
        ) >= 5 THEN v_now + INTERVAL '30 minutes'
        ELSE lockout_until
      END,
      last_attempt_at = v_now
    WHERE id = v_invite.id;

    UPDATE platform_users
    SET
      invite_attempt_count = CASE
        WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
        ELSE invite_attempt_count + 1
      END,
      invite_lockout_until = CASE
        WHEN (
          CASE
            WHEN invite_last_attempt_at IS NULL OR invite_last_attempt_at < v_now - INTERVAL '60 minutes' THEN 1
            ELSE invite_attempt_count + 1
          END
        ) >= 5 THEN v_now + INTERVAL '60 minutes'
        ELSE invite_lockout_until
      END,
      invite_last_attempt_at = v_now
    WHERE id = v_user_id;

    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Atomic consume: update status if still active and not expired
  UPDATE invite_codes
  SET
    status = 'used',
    used_by = v_user_id,
    used_at = v_now
  WHERE id = v_invite.id
    AND status = 'active'
    AND expires_at > v_now
    AND (lockout_until IS NULL OR lockout_until <= v_now);

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  INSERT INTO tenant_users (tenant_id, user_id, role, status)
  VALUES (v_invite.tenant_id, v_user_id, v_invite.target_role, 'active')
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM tenant_users tu
    WHERE tu.tenant_id = v_invite.tenant_id
      AND tu.user_id = v_user_id
      AND tu.status = 'active'
  ) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event_type, resource_type, resource_id, payload)
  VALUES (
    v_invite.tenant_id,
    'bootstrap_function',
    v_user_id::text,
    'invite_consumed',
    'invite_codes',
    v_invite.id::text,
    jsonb_build_object('role_assigned', v_invite.target_role, 'platform', 'telegram')
  );

  RETURN QUERY SELECT true, v_invite.tenant_id, v_invite.target_role;
END;
$$;

ALTER FUNCTION resolve_membership_by_platform_user_id(TEXT) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) OWNER TO groceryclaw_bootstrap_owner;

REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) TO groceryclaw_app_user;
GRANT EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) TO groceryclaw_app_user;

-- Also grant to app_user role if it exists (matches migration 011 pattern)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) TO app_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) TO app_user';
  END IF;
END
$$;

COMMIT;

-- migrate:down
BEGIN;

-- Drop new bootstrap functions
REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM PUBLIC, groceryclaw_app_user;
REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) FROM PUBLIC, groceryclaw_app_user;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM app_user';
    EXECUTE 'REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT, BIGINT) FROM app_user';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS resolve_membership_by_platform_user_id(TEXT);
DROP FUNCTION IF EXISTS consume_invite_code(TEXT, TEXT, BIGINT);

-- Drop employee_permissions
REVOKE SELECT, INSERT, UPDATE, DELETE ON employee_permissions FROM groceryclaw_app_user;
REVOKE ALL ON employee_permissions FROM groceryclaw_bootstrap_owner;
DROP POLICY IF EXISTS rls_employee_permissions_app_user ON employee_permissions;
ALTER TABLE IF EXISTS employee_permissions DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS employee_permissions;

-- Revert secret_versions constraint
ALTER TABLE secret_versions DROP CONSTRAINT IF EXISTS secret_versions_secret_type_check;
ALTER TABLE secret_versions
  ADD CONSTRAINT secret_versions_secret_type_check
  CHECK (secret_type IN ('kiotviet_token'));

-- Drop new RLS policies
DROP POLICY IF EXISTS rls_platform_users_app_user ON platform_users;
DROP POLICY IF EXISTS rls_tenant_users_app_user ON tenant_users;
DROP POLICY IF EXISTS rls_inbound_events_app_user ON inbound_events;
DROP POLICY IF EXISTS rls_pending_notifications_app_user ON pending_notifications;

-- Drop new indexes
DROP INDEX IF EXISTS idx_tenant_users_user;
DROP INDEX IF EXISTS idx_pending_user_new;
DROP INDEX IF EXISTS idx_platform_users_platform_uid;

-- Reverse column renames
ALTER TABLE pending_notifications RENAME COLUMN user_id TO zalo_user_id;
ALTER TABLE inbound_events RENAME COLUMN message_id TO zalo_msg_id;
ALTER TABLE inbound_events RENAME COLUMN user_id TO zalo_user_id;
ALTER TABLE tenant_users RENAME COLUMN user_id TO zalo_user_id;

-- Reverse table rename
ALTER TABLE platform_users DROP COLUMN IF EXISTS telegram_chat_id;
ALTER TABLE platform_users DROP COLUMN IF EXISTS platform;
ALTER TABLE platform_users RENAME TO zalo_users;

-- Restore original unique constraint
ALTER TABLE zalo_users ADD CONSTRAINT zalo_users_platform_user_id_key UNIQUE (platform_user_id);

-- Restore old indexes
CREATE INDEX IF NOT EXISTS idx_tenant_users_zalo ON tenant_users (zalo_user_id);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_notifications (zalo_user_id, status)
  WHERE status = 'pending';

-- Restore old RLS policies
CREATE POLICY rls_zalo_users_app_user ON zalo_users
  FOR ALL TO groceryclaw_app_user
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.zalo_user_id = zalo_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.zalo_user_id = zalo_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  );

CREATE POLICY rls_tenant_users_app_user ON tenant_users
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

CREATE POLICY rls_inbound_events_app_user ON inbound_events
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

CREATE POLICY rls_pending_notifications_app_user ON pending_notifications
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

-- Restore bootstrap_owner grants
REVOKE ALL ON zalo_users FROM groceryclaw_bootstrap_owner;
GRANT SELECT, INSERT, UPDATE ON zalo_users TO groceryclaw_bootstrap_owner;

-- Recreate old bootstrap functions (from migration 010 canonical version)
CREATE OR REPLACE FUNCTION resolve_membership_by_platform_user_id(
  p_platform_user_id TEXT
)
RETURNS TABLE (
  tenant_id UUID,
  tenant_user_id UUID,
  role TEXT,
  status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tu.tenant_id,
    tu.id AS tenant_user_id,
    tu.role,
    tu.status
  FROM zalo_users zu
  JOIN tenant_users tu ON tu.zalo_user_id = zu.id
  WHERE zu.platform_user_id = p_platform_user_id
    AND tu.status = 'active'
  ORDER BY tu.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION consume_invite_code(
  p_platform_user_id TEXT,
  p_code TEXT
)
RETURNS TABLE (
  ok BOOLEAN,
  tenant_id UUID,
  role_assigned TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_normalized TEXT;
  v_pepper_b64 TEXT;
  v_pepper BYTEA;
  v_code_hash BYTEA;
  v_user_id UUID;
  v_user_lockout_until TIMESTAMPTZ;
  v_invite RECORD;
  v_existing_membership_tenant UUID;
BEGIN
  INSERT INTO zalo_users (platform_user_id, last_interaction_at)
  VALUES (p_platform_user_id, v_now)
  ON CONFLICT (platform_user_id)
  DO UPDATE SET updated_at = v_now
  RETURNING id, invite_lockout_until INTO v_user_id, v_user_lockout_until;
  IF v_user_lockout_until IS NOT NULL AND v_user_lockout_until > v_now THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  v_normalized := upper(regexp_replace(trim(p_code), '[ -]', '', 'g'));
  IF v_normalized !~ '^[A-Z0-9]{6,32}$' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  v_pepper_b64 := current_setting('app.invite_pepper_b64', true);
  IF v_pepper_b64 IS NOT NULL AND btrim(v_pepper_b64) <> '' THEN
    v_pepper := decode(v_pepper_b64, 'base64');
  ELSE
    RAISE EXCEPTION 'invite pepper is not configured';
  END IF;
  IF v_pepper IS NULL OR length(v_pepper) < 8 THEN
    RAISE EXCEPTION 'invite pepper is invalid';
  END IF;
  v_code_hash := digest(v_pepper || convert_to(v_normalized, 'UTF8'), 'sha256');
  SELECT tu.tenant_id INTO v_existing_membership_tenant
  FROM tenant_users tu WHERE tu.zalo_user_id = v_user_id AND tu.status = 'active' LIMIT 1;
  IF v_existing_membership_tenant IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  SELECT ic.* INTO v_invite FROM invite_codes ic
  WHERE ic.code_hash = v_code_hash AND ic.status = 'active'
  ORDER BY ic.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_invite.id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF v_invite.expires_at <= v_now OR v_invite.status <> 'active' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  UPDATE invite_codes SET status = 'used', used_by = v_user_id, used_at = v_now
  WHERE id = v_invite.id AND status = 'active' AND expires_at > v_now;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  INSERT INTO tenant_users (tenant_id, zalo_user_id, role, status)
  VALUES (v_invite.tenant_id, v_user_id, v_invite.target_role, 'active')
  ON CONFLICT (tenant_id, zalo_user_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.tenant_id = v_invite.tenant_id AND tu.zalo_user_id = v_user_id AND tu.status = 'active'
  ) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event_type, resource_type, resource_id, payload)
  VALUES (v_invite.tenant_id, 'bootstrap_function', v_user_id::text, 'invite_consumed', 'invite_codes', v_invite.id::text,
    jsonb_build_object('role_assigned', v_invite.target_role));
  RETURN QUERY SELECT true, v_invite.tenant_id, v_invite.target_role;
END;
$$;

ALTER FUNCTION resolve_membership_by_platform_user_id(TEXT) OWNER TO groceryclaw_bootstrap_owner;
ALTER FUNCTION consume_invite_code(TEXT, TEXT) OWNER TO groceryclaw_bootstrap_owner;
REVOKE ALL ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_invite_code(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) TO groceryclaw_app_user;
GRANT EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT) TO groceryclaw_app_user;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) TO app_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT) TO app_user';
  END IF;
END
$$;

COMMIT;
