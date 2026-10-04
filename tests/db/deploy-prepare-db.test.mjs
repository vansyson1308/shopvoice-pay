// scripts/deploy/db_prepare.mjs against real Postgres: migrations, an RLS-bound
// login role for the MCP server, the demo template shop; safe to run every deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { prepare } from '../../scripts/deploy/db_prepare.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const ROLE = 'shopvoice_app_ci';
// Generated per run; the CI database uses trust auth, so the value only has to round-trip.
const PASSWORD = randomBytes(18).toString('base64url');
const DEMO_TENANT = 'c0ffee00-0000-4000-8000-000000000001';

function urlAs(user, password) {
  const u = new URL(dbUrl);
  u.username = user;
  u.password = password;
  return u.href;
}

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test.after(async () => {
  if (skip) return;
  await withClient(dbUrl, (c) => c.query(`DROP ROLE IF EXISTS ${ROLE}`));
});

test('db_prepare creates a plain login role that is bound by RLS, and is idempotent', { skip }, async () => {
  const env = { DB_ADMIN_URL: dbUrl, MCP_DB_USER: ROLE, MCP_DB_PASSWORD: PASSWORD };
  await prepare(env);
  await prepare(env);

  const role = await withClient(dbUrl, async (c) => (await c.query(
    "SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, pg_has_role(rolname, 'groceryclaw_app_runtime', 'member') AS runtime FROM pg_roles WHERE rolname = $1",
    [ROLE]
  )).rows[0]);
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false, runtime: true });

  await withClient(urlAs(ROLE, PASSWORD), async (c) => {
    const none = await c.query('SELECT count(*)::int AS n FROM product_cache');
    assert.equal(none.rows[0].n, 0, 'no tenant set: RLS hides every row');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [DEMO_TENANT]);
    const mine = await c.query('SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants FROM product_cache');
    await c.query('COMMIT');
    assert.ok(mine.rows[0].n > 0, 'the demo template shop is seeded');
    assert.equal(mine.rows[0].tenants, 1);
    await assert.rejects(c.query('CREATE ROLE sneaky'), /permission denied/);
  });
});

test('db_prepare refuses to turn a privileged role into the app login', { skip }, async () => {
  await assert.rejects(prepare({ DB_ADMIN_URL: dbUrl, MCP_DB_USER: 'postgres', MCP_DB_PASSWORD: PASSWORD }), /dedicated login role/);
});
