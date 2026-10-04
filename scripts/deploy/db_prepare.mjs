// Prepares the database before a hosted deploy (Render preDeployCommand):
//   1. waits for Postgres,
//   2. applies migrations as the admin (superuser) role,
//   3. ensures the app's login role: LOGIN, not superuser, no BYPASSRLS, member of
//      groceryclaw_app_runtime only, so every query the MCP server makes is under RLS,
//   4. seeds the demo template shop once (visitor shops are created on demand).
//
// Env: MCP_DB_HOST, MCP_DB_PORT, MCP_DB_NAME, DB_ADMIN_USER, DB_ADMIN_PASSWORD or POSTGRES_PASSWORD (or DB_ADMIN_URL),
//      MCP_DB_USER, MCP_DB_PASSWORD. Nothing secret is printed.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const RUNTIME_ROLE = 'groceryclaw_app_runtime';
const DEMO_TENANT_ID = 'c0ffee00-0000-4000-8000-000000000001';

export function adminUrlFrom(env) {
  if (env.DB_ADMIN_URL) return env.DB_ADMIN_URL;
  const host = env.MCP_DB_HOST;
  const password = env.DB_ADMIN_PASSWORD || env.POSTGRES_PASSWORD;
  if (!host || !password) throw new Error('DB_ADMIN_URL, or MCP_DB_HOST + DB_ADMIN_PASSWORD (or POSTGRES_PASSWORD), is required');
  const user = env.DB_ADMIN_USER || 'postgres';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${env.MCP_DB_PORT || '5432'}/${encodeURIComponent(env.MCP_DB_NAME || 'shopvoice')}`;
}

export function checkAppRole(name, password) {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(name ?? '')) throw new Error('MCP_DB_USER must be a lowercase role name');
  if (name === 'postgres' || name.startsWith('pg_') || name.startsWith('groceryclaw_') || ['app_user', 'admin_reader', 'bootstrap_owner'].includes(name)) {
    throw new Error(`MCP_DB_USER must be a dedicated login role, not ${name}`);
  }
  if ((password ?? '').length < 16) throw new Error('MCP_DB_PASSWORD must be at least 16 characters');
}

async function connectWithRetry(url, attempts = 40) {
  for (let i = 1; ; i += 1) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (i >= attempts) throw error;
      console.log(`db_prepare: waiting for Postgres (${i}/${attempts})`);
      await sleep(3000);
    }
  }
}

async function ensureAppRole(client, name, password) {
  // The role name is validated above; the password travels as a bind parameter and is
  // quoted by format(%L) inside the server, so it never appears in SQL text or logs.
  await client.query('SELECT set_config($1, $2, false)', ['shopvoice.app_role', name]);
  await client.query('SELECT set_config($1, $2, false)', ['shopvoice.app_password', password]);
  await client.query(`DO $$
DECLARE
  r TEXT := current_setting('shopvoice.app_role');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I LOGIN', r);
  END IF;
  EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L',
    r, current_setting('shopvoice.app_password'));
  EXECUTE format('GRANT ${RUNTIME_ROLE} TO %I', r);
END $$`);
  await client.query("SELECT set_config('shopvoice.app_password', '', false)");
  const { rows } = await client.query(
    'SELECT rolsuper, rolbypassrls, rolcanlogin, pg_has_role(rolname, $2, \'member\') AS runtime FROM pg_roles WHERE rolname = $1',
    [name, RUNTIME_ROLE]
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || !role.rolcanlogin || !role.runtime) {
    throw new Error(`db_prepare: app role ${name} is not a plain RLS-bound login role`);
  }
}

export async function prepare(env = process.env) {
  const adminUrl = adminUrlFrom(env);
  checkAppRole(env.MCP_DB_USER, env.MCP_DB_PASSWORD);

  const probe = await connectWithRetry(adminUrl);
  await probe.end();

  const migrate = spawnSync(process.execPath, ['scripts/db_migrate.mjs'], {
    env: { ...env, DATABASE_URL: adminUrl },
    stdio: 'inherit'
  });
  if (migrate.status !== 0) throw new Error('db_prepare: migrations failed');

  const client = await connectWithRetry(adminUrl, 3);
  try {
    await ensureAppRole(client, env.MCP_DB_USER, env.MCP_DB_PASSWORD);
    console.log(`db_prepare: app role ${env.MCP_DB_USER} is RLS-bound (member of ${RUNTIME_ROLE} only)`);

    const seeded = await client.query('SELECT 1 FROM sandbox_shops WHERE tenant_id = $1', [DEMO_TENANT_ID]);
    if (seeded.rowCount === 0) {
      await client.query(readFileSync('db/seed/002_demo_shop_seed.sql', 'utf8'));
      console.log('db_prepare: seeded the demo template shop');
    }
  } finally {
    await client.end();
  }
  console.log('db_prepare: done');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prepare().catch((error) => {
    console.error(`db_prepare failed: ${error.message}`);
    process.exit(1);
  });
}
