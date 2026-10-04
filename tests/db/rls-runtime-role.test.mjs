import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const dbUrl = process.env.DATABASE_URL;

function runSql(sql) {
  const r = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', '|', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'psql failed');
  return r.stdout.trim();
}

test('runtime role cannot bypass tenant RLS and tables are FORCE RLS', { skip: !dbUrl }, () => {
  runSql(`
    BEGIN;
      DELETE FROM jobs;
      DELETE FROM tenant_users;
      DELETE FROM platform_users;
      DELETE FROM tenants;
      INSERT INTO tenants (id, name, status, processing_mode)
      VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A', 'active', 'v2'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B', 'active', 'v2');
    COMMIT;
  `);

  const forced = runSql(`
    SELECT COUNT(*)::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public'
      AND c.relname IN ('tenants','jobs','inbound_events','audit_logs')
      AND c.relforcerowsecurity;
  `);
  assert.equal(forced, '4');

  const visibleA = runSql(`
    BEGIN;
      SET LOCAL ROLE groceryclaw_app_runtime;
      SET LOCAL app.current_tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      SELECT count(*)::text FROM tenants;
    COMMIT;
  `);
  assert.equal(visibleA, '1');

  const crossInsert = runSql(`
    BEGIN;
      SET LOCAL ROLE groceryclaw_app_runtime;
      SET LOCAL app.current_tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      DO $$
      BEGIN
        BEGIN
          INSERT INTO jobs (tenant_id, type, payload)
          VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cross', '{}'::jsonb);
        EXCEPTION WHEN insufficient_privilege THEN
          NULL;
        END;
      END
      $$;
      SELECT count(*)::text FROM jobs WHERE tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND type='cross';
    COMMIT;
  `);
  assert.equal(crossInsert, '0');
});
