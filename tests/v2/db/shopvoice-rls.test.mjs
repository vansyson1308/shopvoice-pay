// RLS isolation tests for migration 017 (ShopVoice inventory/sales/voice tables).
// Requires DATABASE_URL pointing at a migrated database with a superuser role;
// each check runs as groceryclaw_app_runtime via SET LOCAL ROLE so RLS applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPgPool, closePool, query } from '../../../packages/common/dist/index.js';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;

const TENANT_A = 'a1a1a1a1-0000-4000-8000-000000000017';
const TENANT_B = 'b2b2b2b2-0000-4000-8000-000000000017';
const TOKEN_A = 'sv_test_token_for_tenant_a_0000000000000000';
const TOKEN_REVOKED = 'sv_test_token_revoked_000000000000000000000';
const sha = (v) => createHash('sha256').update(v).digest('hex');

const TABLES = [
  'shop_profiles', 'suppliers', 'stock_levels', 'reorder_rules',
  'sales_daily', 'purchase_order_drafts', 'voice_audit_log', 'mcp_access_tokens'
];

let pool;

async function asRuntime(tenantId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE groceryclaw_app_runtime');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function seedTenant(id, name) {
  await query(pool, 'INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [id, name, 'active', 'v2']);
  await query(pool, 'INSERT INTO shop_profiles (tenant_id, shop_name) VALUES ($1, $2)', [id, name]);
  await query(pool, 'INSERT INTO suppliers (tenant_id, supplier_code, name) VALUES ($1, $2, $3)', [id, 'SUP-1', `${name} supplier`]);
  await query(pool, 'INSERT INTO stock_levels (tenant_id, sku, on_hand_qty, source) VALUES ($1, $2, $3, $4)', [id, 'SKU-1', 5, 'seed']);
  await query(pool, 'INSERT INTO reorder_rules (tenant_id, sku, min_qty, reorder_qty) VALUES ($1, $2, $3, $4)', [id, 'SKU-1', 10, 20]);
  await query(pool, 'INSERT INTO sales_daily (tenant_id, sale_date, sku, qty_sold, revenue_vnd) VALUES ($1, CURRENT_DATE, $2, $3, $4)', [id, 'SKU-1', 3, 30000]);
  await query(pool, "INSERT INTO purchase_order_drafts (tenant_id, supplier_code, expires_at) VALUES ($1, $2, now() + interval '5 minutes')", [id, 'SUP-1']);
  await query(pool, 'INSERT INTO voice_audit_log (tenant_id, tool_name) VALUES ($1, $2)', [id, 'get_low_stock']);
}

async function cleanup() {
  for (const id of [TENANT_A, TENANT_B]) {
    for (const table of TABLES) {
      await query(pool, `DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
    }
    await query(pool, 'DELETE FROM tenants WHERE id = $1', [id]);
  }
}

test.before(async () => {
  if (skip) return;
  pool = await createPgPool({ connectionString: dbUrl, applicationName: 'shopvoice-rls-tests' });
  await cleanup();
  await seedTenant(TENANT_A, 'RLS Tenant A');
  await seedTenant(TENANT_B, 'RLS Tenant B');
  await query(pool, 'INSERT INTO mcp_access_tokens (tenant_id, token_hash, label) VALUES ($1, $2, $3)', [TENANT_A, sha(TOKEN_A), 'test']);
  await query(pool, "INSERT INTO mcp_access_tokens (tenant_id, token_hash, label, status) VALUES ($1, $2, $3, 'revoked')", [TENANT_A, sha(TOKEN_REVOKED), 'revoked']);
});

test.after(async () => {
  if (skip) return;
  await cleanup();
  await closePool(pool);
});

test('tenant A sees only its own rows in every ShopVoice table', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT DISTINCT tenant_id::text AS t FROM ${table} WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
      assert.deepEqual(rows.map((r) => r.t), [TENANT_A], `${table} leaked rows`);
    }
  });
});

test('tenant B cannot read tenant A rows even when filtering by A explicitly', { skip }, async () => {
  await asRuntime(TENANT_B, async (client) => {
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT_A]);
      assert.equal(rows[0].n, 0, `${table} exposed tenant A rows to tenant B`);
    }
  });
});

test('missing tenant context yields zero rows (fail-safe)', { skip }, async () => {
  await asRuntime(null, async (client) => {
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `${table} returned rows without tenant context`);
    }
  });
});

test('cross-tenant insert is rejected by WITH CHECK', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(
      client.query('INSERT INTO stock_levels (tenant_id, sku, on_hand_qty) VALUES ($1, $2, $3)', [TENANT_B, 'SKU-X', 1]),
      /row-level security/
    );
  });
});

test('voice_audit_log is append-only for the runtime role', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(client.query("UPDATE voice_audit_log SET tool_name = 'x'"), /permission denied/);
  });
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(client.query('DELETE FROM voice_audit_log'), /permission denied/);
  });
});

test('runtime role cannot mint MCP tokens directly', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(
      client.query('INSERT INTO mcp_access_tokens (tenant_id, token_hash) VALUES ($1, $2)', [TENANT_A, sha('forged-token-value-000000000000000000')]),
      /permission denied/
    );
  });
});

test('resolve_mcp_access_token maps an active token hash to its tenant without tenant context', { skip }, async () => {
  await asRuntime(null, async (client) => {
    const ok = await client.query('SELECT tenant_id::text AS t FROM resolve_mcp_access_token($1)', [sha(TOKEN_A)]);
    assert.deepEqual(ok.rows.map((r) => r.t), [TENANT_A]);
    const revoked = await client.query('SELECT tenant_id FROM resolve_mcp_access_token($1)', [sha(TOKEN_REVOKED)]);
    assert.equal(revoked.rows.length, 0);
    const unknown = await client.query('SELECT tenant_id FROM resolve_mcp_access_token($1)', [sha('nope')]);
    assert.equal(unknown.rows.length, 0);
  });
});
