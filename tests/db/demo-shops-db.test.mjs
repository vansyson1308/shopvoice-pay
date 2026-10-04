// "Try the demo" visitor shops on Postgres (migration 023): created and reset
// through SECURITY DEFINER functions called by the runtime role, refused for
// real shops, and cleaned up once idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPgPool, closePool, query } from '../../packages/common/dist/index.js';
import { PgShopStore } from '../../apps/mcp-server/dist/pg-store.js';
import { PgDemoShops } from '../../apps/mcp-server/dist/demo-shops.js';
import { connectMockPayPal } from '../../apps/mcp-server/dist/payments-setup.js';
import { mockPayments } from '../unit/mcp-harness.mjs';
import { runtimePool, applyDemoSeed } from './db-harness.mjs';
import { buildSandboxCatalogue, DEMO_TENANT_ID } from '../../scripts/gen_demo_seed.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const REAL_TENANT = 'd1d1d1d1-0000-4000-8000-000000000023';
let admin;
let shops;
let store;

test.before(async () => {
  if (skip) return;
  admin = await createPgPool({ connectionString: dbUrl, applicationName: 'demo-shops-db-tests', statementTimeoutMs: 30000 });
  await applyDemoSeed(admin);
  await query(admin, "INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, 'A real shop', 'active', 'v2') ON CONFLICT (id) DO NOTHING", [REAL_TENANT]);
  const payments = mockPayments(Date.now);
  const runtime = runtimePool(admin);
  store = new PgShopStore(runtime);
  shops = new PgDemoShops(runtime, JSON.stringify(buildSandboxCatalogue({})), payments, (t) => connectMockPayPal(payments, store, t));
});

test.after(async () => {
  if (skip) return;
  await query(admin, 'DELETE FROM tenants WHERE id = $1', [REAL_TENANT]);
  await closePool(admin);
});

test('a visitor shop is seeded, has its own token and a simulated PayPal account', { skip }, async () => {
  const { token, tenantId } = await shops.create();
  const resolved = await store.resolveTokenHash(createHash('sha256').update(token).digest('hex'));
  assert.equal(resolved.tenantId, tenantId);
  const counts = (await query(admin, `SELECT
      (SELECT count(*)::int FROM product_cache WHERE tenant_id = $1) AS products,
      (SELECT count(*)::int FROM supplier_payments WHERE tenant_id = $1) AS payments,
      (SELECT count(*)::int FROM payment_methods WHERE tenant_id = $1 AND status = 'active') AS methods,
      (SELECT kind FROM sandbox_shops WHERE tenant_id = $1) AS kind`, [tenantId])).rows[0];
  assert.deepEqual(counts, { products: 47, payments: 9, methods: 1, kind: 'visitor' });

  // A payment made in the shop disappears on reset; the PayPal account stays.
  await query(admin, "INSERT INTO supplier_payments (tenant_id, supplier_code, currency, amount_requested_minor, status, decision, lines_fingerprint, created_by) VALUES ($1, 'SUP-DAIRY', 'USD', 8400, 'pending_approval', 'autopay', 'x', 'agent')", [tenantId]);
  assert.equal(await shops.reset(tenantId), true);
  const after = (await query(admin, "SELECT (SELECT count(*)::int FROM supplier_payments WHERE tenant_id = $1) AS payments, (SELECT count(*)::int FROM payment_methods WHERE tenant_id = $1 AND status = 'active') AS methods", [tenantId])).rows[0];
  assert.deepEqual(after, { payments: 9, methods: 1 });
});

test('reset refuses a real shop; the shared demo shop can be reset', { skip }, async () => {
  assert.equal(await shops.reset(REAL_TENANT), false);
  assert.equal(await shops.reset(DEMO_TENANT_ID), true);
});

test('idle visitor shops are cleaned up; recent ones and real shops stay', { skip }, async () => {
  const idle = await shops.create();
  const fresh = await shops.create();
  await query(admin, "UPDATE sandbox_shops SET created_at = now() - interval '10 days' WHERE tenant_id = $1", [idle.tenantId]);
  await query(admin, "UPDATE mcp_access_tokens SET last_used_at = now() - interval '10 days' WHERE tenant_id = $1", [idle.tenantId]);
  const removed = await shops.cleanup(3);
  assert.ok(removed >= 1);
  const left = (await query(admin, 'SELECT id FROM tenants WHERE id = ANY($1)', [[idle.tenantId, fresh.tenantId, REAL_TENANT, DEMO_TENANT_ID]])).rows.map((r) => r.id).sort();
  assert.deepEqual(left, [fresh.tenantId, REAL_TENANT, DEMO_TENANT_ID].sort());
  assert.equal(await store.resolveTokenHash(createHash('sha256').update(idle.token).digest('hex')), null);
});
