// The hero money path through MCP against real Postgres + RLS (mock PayPal).
// Session tools commit each ledger write on its own connection as the runtime
// role, so this checks that the autocommit repository, RLS and migration 021's
// one-live-payment-per-draft index work together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPgPool, closePool, query } from '../../packages/common/dist/index.js';
import { PgShopStore } from '../../apps/mcp-server/dist/pg-store.js';
import { startMcpServer, connectClient, mockPayments, spoken } from '../unit/mcp-harness.mjs';
import { runtimePool, applyDemoSeed } from './db-harness.mjs';
import { DEMO_TENANT_ID } from '../../scripts/gen_demo_seed.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const TOKEN = 'sv_dbtest_payments_token_000000000000000000000000';
const sha = (v) => createHash('sha256').update(v).digest('hex');

let admin;
let srv;
let client;
let startedAt;

test.before(async () => {
  if (skip) return;
  admin = await createPgPool({ connectionString: dbUrl, applicationName: 'mcp-payments-db-tests', statementTimeoutMs: 30000 });
  await applyDemoSeed(admin);
  startedAt = (await query(admin, 'SELECT now() AS t')).rows[0].t;
  await query(admin, "UPDATE payment_methods SET status = 'revoked' WHERE tenant_id = $1 AND status = 'active'", [DEMO_TENANT_ID]);
  await query(admin, "INSERT INTO mcp_access_tokens (tenant_id, token_hash, label) VALUES ($1, $2, 'db-payments-test') ON CONFLICT (token_hash) DO NOTHING", [DEMO_TENANT_ID, sha(TOKEN)]);
  srv = await startMcpServer({ store: new PgShopStore(runtimePool(admin)), payments: mockPayments(Date.now) });
  ({ client } = await connectClient(srv.url, TOKEN));
});

test.after(async () => {
  if (skip) return;
  await client.close();
  await srv.close();
  await query(admin, 'DELETE FROM mcp_access_tokens WHERE token_hash = $1', [sha(TOKEN)]);
  await applyDemoSeed(admin);
  await closePool(admin);
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });

test('reorder milk and eggs: milk held on PayPal, eggs wait; ledger rows and events are durable under RLS', { skip }, async () => {
  const draft = await call('create_reorder_draft', { items: [{ product: 'milk' }, { product: 'eggs' }] });
  const token = draft.structuredContent.confirmation_token;
  const r = await call('confirm_reorder', { confirmation_token: token });
  assert.ok(!r.isError, spoken(r));
  const by = Object.fromEntries(r.structuredContent.payments.map((p) => [p.supplier_code, p]));
  assert.equal(by['SUP-DAIRY'].status, 'authorized');
  assert.equal(by['SUP-EGGS'].status, 'pending_approval');
  assert.equal(by['SUP-EGGS'].approval.state, 'waiting_in_console');

  const { rows } = await query(admin, `SELECT p.supplier_code, p.status, p.amount_authorized_minor, p.draft_id, p.paypal_authorization_id,
      (SELECT array_agg(e.kind ORDER BY e.created_at) FROM payment_events e WHERE e.payment_id = p.id) AS kinds,
      (SELECT array_agg(e.paypal_request_id) FROM payment_events e WHERE e.payment_id = p.id AND e.paypal_request_id IS NOT NULL) AS request_ids
    FROM supplier_payments p WHERE p.tenant_id = $1 AND p.created_at >= $2 ORDER BY p.supplier_code`, [DEMO_TENANT_ID, startedAt]);
  assert.equal(rows.length, 2);
  const dairy = rows.find((x) => x.supplier_code === 'SUP-DAIRY');
  assert.equal(Number(dairy.amount_authorized_minor), 8400);
  assert.ok(dairy.paypal_authorization_id, 'the PayPal hold is recorded');
  assert.deepEqual(dairy.kinds, ['policy_evaluated', 'authorized']);
  assert.deepEqual(dairy.request_ids, [`svp-auth-${r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-DAIRY').payment_id}`]);
  assert.ok(!JSON.stringify(r).includes(dairy.paypal_authorization_id), 'the authorization id stays out of tool output');
  const eggs = rows.find((x) => x.supplier_code === 'SUP-EGGS');
  assert.deepEqual(eggs.kinds, ['policy_evaluated', 'approval_requested']);
  assert.ok(draft.structuredContent.drafts.some((d) => d.draft_id === eggs.draft_id), 'payments point at their drafts');

  // A second confirm reports the same two payments; the database refuses a second live payment per draft.
  const again = await call('confirm_reorder', { confirmation_token: token });
  assert.equal(again.structuredContent.status, 'already_confirmed');
  const count = await query(admin, 'SELECT count(*)::int AS n FROM supplier_payments WHERE tenant_id = $1 AND created_at >= $2', [DEMO_TENANT_ID, startedAt]);
  assert.equal(count.rows[0].n, 2);
  await assert.rejects(
    query(admin, "INSERT INTO supplier_payments (tenant_id, draft_id, supplier_code, currency, amount_requested_minor, status, decision, lines_fingerprint, created_by) VALUES ($1, $2, 'SUP-DAIRY', 'USD', 8400, 'pending_approval', 'autopay', 'fp', 'agent')", [DEMO_TENANT_ID, dairy.draft_id]),
    /uq_supplier_payments_live_draft/
  );
});

test('delivery and refund write captures, releases, payouts and refunds to the ledger', { skip }, async () => {
  const r = await call('record_delivery', { supplier: 'Northside Dairy', items: [{ product: 'whole milk', received_qty: 8 }] });
  assert.equal(r.structuredContent.status, 'recorded', spoken(r));
  assert.equal(r.structuredContent.charged, 56);
  const ask = await call('request_refund', { supplier: 'dairy', amount: 7, reason: 'one crate was spoiled' });
  const done = await call('request_refund', { reason: 'one crate was spoiled', confirmation_token: ask.structuredContent.confirmation_token });
  assert.equal(done.structuredContent.status, 'refunded', spoken(done));

  const { rows } = await query(admin, `SELECT status, amount_captured_minor, amount_voided_minor, amount_settled_minor, amount_refunded_minor,
      (SELECT array_agg(kind ORDER BY created_at) FROM payment_events e WHERE e.payment_id = p.id) AS kinds,
      (SELECT count(*)::int FROM deliveries d WHERE d.payment_id = p.id) AS deliveries
    FROM supplier_payments p WHERE tenant_id = $1 AND created_at >= $2 AND supplier_code = 'SUP-DAIRY'`, [DEMO_TENANT_ID, startedAt]);
  const p = rows[0];
  assert.equal(Number(p.amount_captured_minor), 5600);
  assert.equal(Number(p.amount_voided_minor), 2800);
  assert.equal(Number(p.amount_settled_minor), 5600);
  assert.equal(Number(p.amount_refunded_minor), 700);
  assert.equal(p.deliveries, 1);
  assert.deepEqual(p.kinds, ['policy_evaluated', 'authorized', 'captured', 'voided', 'payout_sent', 'refunded']);
});
