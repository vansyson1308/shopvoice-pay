-- migrate:up
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader') THEN
    CREATE ROLE admin_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bootstrap_owner') THEN
    CREATE ROLE bootstrap_owner NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user, admin_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT ON audit_logs, admin_audit_logs TO admin_reader;

COMMIT;

-- migrate:down
BEGIN;

REVOKE SELECT ON audit_logs, admin_audit_logs FROM admin_reader;
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM app_user;
REVOKE USAGE ON SCHEMA public FROM app_user, admin_reader;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bootstrap_owner') THEN
    DROP ROLE bootstrap_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_reader') THEN
    DROP ROLE admin_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    DROP ROLE app_user;
  END IF;
END
$$;

COMMIT;
