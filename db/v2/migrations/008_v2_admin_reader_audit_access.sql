-- migrate:up
BEGIN;

REVOKE SELECT ON audit_logs FROM admin_reader;
REVOKE SELECT ON admin_audit_logs FROM admin_reader;

COMMIT;

-- migrate:down
BEGIN;

GRANT SELECT ON audit_logs TO admin_reader;
GRANT SELECT ON admin_audit_logs TO admin_reader;

COMMIT;
