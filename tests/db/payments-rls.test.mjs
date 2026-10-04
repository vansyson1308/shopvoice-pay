// RLS isolation and ledger-invariant tests for migration 019 (PayPal payments).
// Requires DATABASE_URL pointing at a migrated database with a superuser role;
// each check runs as groceryclaw_app_runtime via SET LOCAL ROLE so RLS applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgPool, closePool, query } from '../../packages/common/dist/index.js';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;

const TENANT_A = 'a1a1a1a1-0000-4000-8000-000000000019';
const TENANT_B = 'b2b2b2b2-0000-4000-8000-000000000019';

const TABLES = ['supplier_payees', 'spend_policies', 'payment_methods', 'supplier_price_history', 'supplier_payments', 'payment_events', 'deliveries', 'invoice_matches'];

let pool;
const ids = {};

async function asRuntime(tenantId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE groceryclaw_app_runtime');
    if (tenantId !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function one(sql, params) {
  const { rows } = await query(pool, sql, params);
  return rows[0];
}

async function seedTenant(id, name) {
  await query(pool, 'INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [id, name, 'active', 'v2']);
  await query(pool, 'INSERT INTO supplier_payees (tenant_id, supplier_code, paypal_email, verified) VALUES ($1, $2, $3, true)', [id, 'SUP-DAIRY', 'dairy@business.example.com']);
  await query(pool, 'INSERT INTO spend_policies (tenant_id, allow_listed_supplier_codes) VALUES ($1, $2)', [id, ['SUP-DAIRY']]);
  await query(pool, "INSERT INTO payment_methods (tenant_id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce, payer_label) VALUES ($1, 'active', '\\x01', '\\x02', '\\x03', '\\x04', 'm***@personal.example.com')", [id]);
  await query(pool, "INSERT INTO supplier_price_history (tenant_id, supplier_code, sku, unit_cost_minor, observed_on) VALUES ($1, 'SUP-DAIRY', 'MILK-1G', 700, CURRENT_DATE)", [id]);
  const payment = await one(
    "INSERT INTO supplier_payments (tenant_id, supplier_code, currency, amount_requested_minor, amount_authorized_minor, status, decision, lines_fingerprint, created_by) VALUES ($1, 'SUP-DAIRY', 'USD', 8400, 8400, 'authorized', 'autopay', 'fp', 'agent') RETURNING id",
    [id]
  );
  await query(pool, "INSERT INTO payment_events (tenant_id, payment_id, kind, amount_minor, currency, actor, paypal_request_id) VALUES ($1, $2, 'authorized', 8400, 'USD', 'agent', $3)", [id, payment.id, `req-${id}`]);
  const delivery = await one("INSERT INTO deliveries (tenant_id, payment_id, source, outcome, delivered_value_minor, currency) VALUES ($1, $2, 'voice', 'full', 8400, 'USD') RETURNING id", [id, payment.id]);
  await query(pool, "INSERT INTO invoice_matches (tenant_id, delivery_id, result) VALUES ($1, $2, 'match')", [id, delivery.id]);
  ids[id] = { payment: payment.id, delivery: delivery.id };
}

async function cleanup() {
  for (const id of [TENANT_A, TENANT_B]) await query(pool, 'DELETE FROM tenants WHERE id = $1', [id]);
}

test.before(async () => {
  if (skip) return;
  pool = await createPgPool({ connectionString: dbUrl, applicationName: 'payments-rls-tests' });
  await cleanup();
  await seedTenant(TENANT_A, 'Payments Tenant A');
  await seedTenant(TENANT_B, 'Payments Tenant B');
});

test.after(async () => {
  if (skip) return;
  await cleanup();
  await closePool(pool);
});

test('tenant A sees only its own rows in every payments table', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT DISTINCT tenant_id::text AS t FROM ${table} WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
      assert.deepEqual(rows.map((r) => r.t), [TENANT_A], `${table} leaked rows`);
    }
  });
});

test('missing tenant context yields zero rows in every payments table', { skip }, async () => {
  await asRuntime(null, async (client) => {
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `${table} returned rows without tenant context`);
    }
  });
});

test('cross-tenant writes are rejected by WITH CHECK', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(
      client.query("INSERT INTO supplier_payments (tenant_id, supplier_code, currency, amount_requested_minor, status, decision, lines_fingerprint, created_by) VALUES ($1, 'SUP-DAIRY', 'USD', 100, 'pending_approval', 'step_up', 'x', 'agent')", [TENANT_B]),
      /row-level security/
    );
  });
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(client.query("INSERT INTO supplier_payees (tenant_id, supplier_code, paypal_email) VALUES ($1, 'SUP-X', 'x@business.example.com')", [TENANT_B]), /row-level security/);
  });
});

test("tenant A cannot touch tenant B's ledger row, even by id", { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    const res = await client.query("UPDATE supplier_payments SET status = 'voided' WHERE id = $1", [ids[TENANT_B].payment]);
    assert.equal(res.rowCount, 0);
  });
});

test('event log, deliveries and matches are append-only; ledger rows cannot be deleted', { skip }, async () => {
  for (const sql of [
    "UPDATE payment_events SET reason = 'x'", 'DELETE FROM payment_events',
    "UPDATE deliveries SET outcome = 'none'", 'DELETE FROM deliveries',
    "UPDATE invoice_matches SET result = 'match'", 'DELETE FROM invoice_matches',
    'DELETE FROM supplier_payments', 'DELETE FROM payment_methods', 'DELETE FROM spend_policies'
  ]) {
    await asRuntime(TENANT_A, async (client) => {
      await assert.rejects(client.query(sql), /permission denied/, sql);
    });
  }
});

test('ledger invariants hold at the database level', { skip }, async () => {
  const id = ids[TENANT_A].payment;
  const bad = [
    ['captured + voided > authorized', 'UPDATE supplier_payments SET amount_captured_minor = 8000, amount_voided_minor = 401 WHERE id = $1', /ck_supplier_payments_capture_void_le_authorized/],
    ['refunded > captured', 'UPDATE supplier_payments SET amount_captured_minor = 100, amount_refunded_minor = 101 WHERE id = $1', /ck_supplier_payments_refund_le_captured/],
    ['settled > captured', 'UPDATE supplier_payments SET amount_settled_minor = 1 WHERE id = $1', /ck_supplier_payments_settled_le_net/],
    ['authorized > requested', 'UPDATE supplier_payments SET amount_authorized_minor = 9000 WHERE id = $1', /ck_supplier_payments_authorized_le_requested/],
    ['negative money', 'UPDATE supplier_payments SET amount_captured_minor = -1 WHERE id = $1', /check constraint/],
    ['unknown status', "UPDATE supplier_payments SET status = 'paid' WHERE id = $1", /check constraint/]
  ];
  for (const [name, sql, pattern] of bad) {
    await asRuntime(TENANT_A, async (client) => {
      await assert.rejects(client.query(sql, [id]), pattern, name);
    });
  }
  await asRuntime(TENANT_A, async (client) => {
    const ok = await client.query("UPDATE supplier_payments SET amount_captured_minor = 7000, amount_voided_minor = 1400, status = 'partially_captured' WHERE id = $1", [id]);
    assert.equal(ok.rowCount, 1);
  });
});

test('a PayPal-Request-Id can be recorded only once per tenant', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(
      client.query("INSERT INTO payment_events (tenant_id, payment_id, kind, amount_minor, currency, actor, paypal_request_id) VALUES ($1, $2, 'captured', 1, 'USD', 'agent', $3)", [TENANT_A, ids[TENANT_A].payment, `req-${TENANT_A}`]),
      /uq_payment_events_request/
    );
  });
});

test('only one active PayPal method per shop; policy hard caps cannot undercut budgets', { skip }, async () => {
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(
      client.query("INSERT INTO payment_methods (tenant_id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce) VALUES ($1, 'active', '\\x01', '\\x02', '\\x03', '\\x04')", [TENANT_A]),
      /uq_payment_methods_one_active/
    );
  });
  await asRuntime(TENANT_A, async (client) => {
    await assert.rejects(client.query('UPDATE spend_policies SET daily_hard_cap_minor = 100 WHERE tenant_id = $1', [TENANT_A]), /check constraint/);
  });
});
