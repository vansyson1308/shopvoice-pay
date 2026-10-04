-- migrate:up
BEGIN;

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
  -- Ensure user exists and read lockout state
  INSERT INTO zalo_users (platform_user_id, last_interaction_at)
  VALUES (p_platform_user_id, v_now)
  ON CONFLICT (platform_user_id)
  DO UPDATE SET updated_at = v_now
  RETURNING id, invite_lockout_until INTO v_user_id, v_user_lockout_until;

  -- Per-user lockout check
  IF v_user_lockout_until IS NOT NULL AND v_user_lockout_until > v_now THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Normalize: trim, remove spaces/hyphens, uppercase, strict charset/length
  v_normalized := upper(regexp_replace(trim(p_code), '[ -]', '', 'g'));
  IF v_normalized !~ '^[A-Z0-9]{6,32}$' THEN
    UPDATE zalo_users
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
  WHERE tu.zalo_user_id = v_user_id
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
    UPDATE zalo_users
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

    UPDATE zalo_users
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

  INSERT INTO tenant_users (tenant_id, zalo_user_id, role, status)
  VALUES (v_invite.tenant_id, v_user_id, v_invite.target_role, 'active')
  ON CONFLICT (tenant_id, zalo_user_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM tenant_users tu
    WHERE tu.tenant_id = v_invite.tenant_id
      AND tu.zalo_user_id = v_user_id
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
    jsonb_build_object('role_assigned', v_invite.target_role)
  );

  RETURN QUERY SELECT true, v_invite.tenant_id, v_invite.target_role;
END;
$$;

COMMIT;

-- migrate:down
BEGIN;
-- No-op rollback. Previous function definition can be recovered from migration 004.
COMMIT;
