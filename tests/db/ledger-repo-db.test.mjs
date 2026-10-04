// PaymentsRepository contract against Postgres (migration 019). Each unit of
// work runs as groceryclaw_app_runtime with the tenant set, exactly like the
// server, so RLS and the CHECK constraints are in force.
import test from 'node:test';
import { createPgPool, closePool, query } from '../../packages/common/dist/index.js';
import { PgPaymentsRepository } from '../../apps/mcp-server/dist/ledger/index.js';
import { runLedgerContract } from '../unit/ledger-contract.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const TENANT = 'c3c3c3c3-0000-4000-8000-000000000019';
let pool;

async function withRepo(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE groceryclaw_app_runtime');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT]);
    const result = await work(new PgPaymentsRepository(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test.before(async () => {
  if (skip) return;
  pool = await createPgPool({ connectionString: dbUrl, applicationName: 'ledger-contract-tests' });
  await query(pool, 'DELETE FROM tenants WHERE id = $1', [TENANT]);
  await query(pool, 'INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, $2, $3, $4)', [TENANT, 'Ledger Contract', 'active', 'v2']);
});

test.after(async () => {
  if (skip) return;
  await query(pool, 'DELETE FROM tenants WHERE id = $1', [TENANT]);
  await closePool(pool);
});

async function makeDraftId() {
  const { rows } = await query(pool, "INSERT INTO purchase_order_drafts (tenant_id, supplier_code, lines, total_minor, status, created_via, expires_at) VALUES ($1, 'SUP-DAIRY', '[]'::jsonb, 14400, 'confirmed', 'voice', now()) RETURNING id", [TENANT]);
  return rows[0].id;
}

runLedgerContract('pg ledger', { withRepo: (fn) => withRepo(fn), makeDraftId, skip });
