-- migrate:up
BEGIN;

-- Fix backward role grants from migration 003.
-- Migration 003 ran: GRANT app_user TO groceryclaw_app_user
-- which gives groceryclaw_app_user membership in app_user (wrong direction).
-- The gateway connects as app_user, which needs membership in
-- groceryclaw_app_user so that RLS policies (TO groceryclaw_app_user) apply.

DO $$
BEGIN
  -- First revoke the wrong direction if it exists
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_app_user')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user')
     AND EXISTS (SELECT 1 FROM pg_auth_members m
                 JOIN pg_roles a ON a.oid = m.member
                 JOIN pg_roles b ON b.oid = m.roleid
                 WHERE a.rolname = 'groceryclaw_app_user' AND b.rolname = 'app_user') THEN
    REVOKE app_user FROM groceryclaw_app_user;
  END IF;
  -- Then grant in the correct direction
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_app_user') THEN
    GRANT groceryclaw_app_user TO app_user;
  END IF;

  -- Same for admin_reader
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_admin_reader')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader')
     AND EXISTS (SELECT 1 FROM pg_auth_members m
                 JOIN pg_roles a ON a.oid = m.member
                 JOIN pg_roles b ON b.oid = m.roleid
                 WHERE a.rolname = 'groceryclaw_admin_reader' AND b.rolname = 'admin_reader') THEN
    REVOKE admin_reader FROM groceryclaw_admin_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_admin_reader') THEN
    GRANT groceryclaw_admin_reader TO admin_reader;
  END IF;
END
$$;

-- Also grant execute on bootstrap functions to app_user directly,
-- in case role inheritance does not propagate execute permissions.
GRANT EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT) TO app_user;

COMMIT;

-- migrate:down
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_app_user') THEN
    REVOKE groceryclaw_app_user FROM app_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_admin_reader') THEN
    REVOKE groceryclaw_admin_reader FROM admin_reader;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION resolve_membership_by_platform_user_id(TEXT) FROM app_user;
REVOKE EXECUTE ON FUNCTION consume_invite_code(TEXT, TEXT) FROM app_user;

COMMIT;
