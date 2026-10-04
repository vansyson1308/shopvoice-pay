-- migrate:up
BEGIN;

-- Canonical DB roles for runtime boundaries
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_app_user') THEN
    CREATE ROLE groceryclaw_app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_admin_reader') THEN
    CREATE ROLE groceryclaw_admin_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_bootstrap_owner') THEN
    CREATE ROLE groceryclaw_bootstrap_owner NOLOGIN;
  END IF;
END
$$;

-- Backward-compat aliases from earlier stub migration (if present)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT app_user TO groceryclaw_app_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader') THEN
    GRANT admin_reader TO groceryclaw_admin_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bootstrap_owner') THEN
    GRANT bootstrap_owner TO groceryclaw_bootstrap_owner;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO groceryclaw_app_user, groceryclaw_admin_reader;

-- app_user baseline grants (RLS will restrict tenant access)
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON zalo_users TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_users TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON invite_codes TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON secret_versions TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_events TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO groceryclaw_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_notifications TO groceryclaw_app_user;
GRANT SELECT, INSERT ON audit_logs TO groceryclaw_app_user;

-- admin_reader gets no direct read on tenant tables by default.
-- Cross-tenant audit access is via controlled SECURITY DEFINER function below.
REVOKE ALL ON audit_logs FROM groceryclaw_admin_reader;
REVOKE ALL ON tenants, zalo_users, tenant_users, invite_codes, secret_versions, inbound_events, jobs, idempotency_keys, pending_notifications FROM groceryclaw_admin_reader;

-- Fail-safe tenant resolver: missing/invalid app.current_tenant returns NULL (never throws)
CREATE OR REPLACE FUNCTION _rls_tenant_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_raw text;
BEGIN
  v_raw := current_setting('app.current_tenant', true);

  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN NULL;
    WHEN others THEN
      RETURN NULL;
  END;
END;
$$;

-- RLS enablement across all tenant-scoped tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- tenants
DROP POLICY IF EXISTS rls_tenants_app_user ON tenants;
CREATE POLICY rls_tenants_app_user ON tenants
  FOR ALL TO groceryclaw_app_user
  USING (id = _rls_tenant_id())
  WITH CHECK (id = _rls_tenant_id());

-- zalo_users: scoped through tenant membership
DROP POLICY IF EXISTS rls_zalo_users_app_user ON zalo_users;
CREATE POLICY rls_zalo_users_app_user ON zalo_users
  FOR ALL TO groceryclaw_app_user
  USING (
    EXISTS (
      SELECT 1
      FROM tenant_users tu
      WHERE tu.zalo_user_id = zalo_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM tenant_users tu
      WHERE tu.zalo_user_id = zalo_users.id
        AND tu.tenant_id = _rls_tenant_id()
    )
  );

-- tenant_id direct tables
DROP POLICY IF EXISTS rls_tenant_users_app_user ON tenant_users;
CREATE POLICY rls_tenant_users_app_user ON tenant_users
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_invite_codes_app_user ON invite_codes;
CREATE POLICY rls_invite_codes_app_user ON invite_codes
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_secret_versions_app_user ON secret_versions;
CREATE POLICY rls_secret_versions_app_user ON secret_versions
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_inbound_events_app_user ON inbound_events;
CREATE POLICY rls_inbound_events_app_user ON inbound_events
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_jobs_app_user ON jobs;
CREATE POLICY rls_jobs_app_user ON jobs
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_idempotency_keys_app_user ON idempotency_keys;
CREATE POLICY rls_idempotency_keys_app_user ON idempotency_keys
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_pending_notifications_app_user ON pending_notifications;
CREATE POLICY rls_pending_notifications_app_user ON pending_notifications
  FOR ALL TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

-- audit logs: app_user is tenant-scoped only (no cross-tenant read)
DROP POLICY IF EXISTS rls_audit_logs_app_user_select ON audit_logs;
CREATE POLICY rls_audit_logs_app_user_select ON audit_logs
  FOR SELECT TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_audit_logs_app_user_insert ON audit_logs;
CREATE POLICY rls_audit_logs_app_user_insert ON audit_logs
  FOR INSERT TO groceryclaw_app_user
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_audit_logs_app_user_update ON audit_logs;
CREATE POLICY rls_audit_logs_app_user_update ON audit_logs
  FOR UPDATE TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id())
  WITH CHECK (tenant_id = _rls_tenant_id());

DROP POLICY IF EXISTS rls_audit_logs_app_user_delete ON audit_logs;
CREATE POLICY rls_audit_logs_app_user_delete ON audit_logs
  FOR DELETE TO groceryclaw_app_user
  USING (tenant_id = _rls_tenant_id());

-- Controlled admin-only audit access path (no raw table grants required)
CREATE OR REPLACE FUNCTION admin_get_audit_logs(p_limit int DEFAULT 100)
RETURNS SETOF audit_logs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM audit_logs
  ORDER BY created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 1000));
$$;

REVOKE ALL ON FUNCTION admin_get_audit_logs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_get_audit_logs(int) TO groceryclaw_admin_reader;

COMMIT;

-- migrate:down
BEGIN;

REVOKE EXECUTE ON FUNCTION admin_get_audit_logs(int) FROM groceryclaw_admin_reader;
DROP FUNCTION IF EXISTS admin_get_audit_logs(int);

DROP POLICY IF EXISTS rls_audit_logs_app_user_delete ON audit_logs;
DROP POLICY IF EXISTS rls_audit_logs_app_user_update ON audit_logs;
DROP POLICY IF EXISTS rls_audit_logs_app_user_insert ON audit_logs;
DROP POLICY IF EXISTS rls_audit_logs_app_user_select ON audit_logs;
DROP POLICY IF EXISTS rls_pending_notifications_app_user ON pending_notifications;
DROP POLICY IF EXISTS rls_idempotency_keys_app_user ON idempotency_keys;
DROP POLICY IF EXISTS rls_jobs_app_user ON jobs;
DROP POLICY IF EXISTS rls_inbound_events_app_user ON inbound_events;
DROP POLICY IF EXISTS rls_secret_versions_app_user ON secret_versions;
DROP POLICY IF EXISTS rls_invite_codes_app_user ON invite_codes;
DROP POLICY IF EXISTS rls_tenant_users_app_user ON tenant_users;
DROP POLICY IF EXISTS rls_zalo_users_app_user ON zalo_users;
DROP POLICY IF EXISTS rls_tenants_app_user ON tenants;

ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE pending_notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE secret_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS _rls_tenant_id();

REVOKE SELECT, INSERT ON audit_logs FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON pending_notifications FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON idempotency_keys FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON jobs FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON inbound_events FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON secret_versions FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON invite_codes FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON tenant_users FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON zalo_users FROM groceryclaw_app_user;
REVOKE SELECT, INSERT, UPDATE, DELETE ON tenants FROM groceryclaw_app_user;

REVOKE USAGE ON SCHEMA public FROM groceryclaw_app_user, groceryclaw_admin_reader;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_bootstrap_owner') THEN
    DROP ROLE groceryclaw_bootstrap_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_admin_reader') THEN
    DROP ROLE groceryclaw_admin_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groceryclaw_app_user') THEN
    DROP ROLE groceryclaw_app_user;
  END IF;
END
$$;

COMMIT;
