// ShopVoice tools against real Postgres + RLS (requires DATABASE_URL with a
// superuser for fixtures). The MCP server's store runs as
// groceryclaw_app_runtime, so every query goes through the RLS policies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createPgPool, closePool, query } from '../../../packages/common/dist/index.js';
import { PgShopStore } from '../../../apps/mcp-server/dist/pg-store.js';
import { startMcpServer, connectClient, spoken, wordCount } from '../mcp-harness.mjs';
import { DEMO_TENANT_ID, todayInTimezone } from '../../../scripts/v2/gen_demo_seed.mjs';

const dbUrl = process.env.DATABASE_URL;
const skip = !dbUrl;
const OTHER_TENANT = 'b0b0b0b0-0000-4000-8000-0000000000db';
const TOKEN_DEMO = 'sv_dbtest_demo_token_00000000000000000000000000';
const TOKEN_OTHER = 'sv_dbtest_other_token_0000000000000000000000000';
const sha = (v) => createHash('sha256').update(v).digest('hex');

let admin;
let srv;
let client;

/** Pool whose connections run as the RLS-bound runtime role. */
function runtimePool(pool) {
  const asRuntime = async () => {
    const c = await pool.connect();
    await c.query('SET ROLE groceryclaw_app_runtime');
    return {
      query: (text, params) => c.query(text, params),
      release: () => {
        c.query('RESET ROLE').finally(() => c.release());
      }
    };
  };
  return {
    connect: asRuntime,
    async query(text, params) {
      const c = await asRuntime();
      try {
        return await c.query(text, params);
      } finally {
        c.release();
      }
    },
    end: () => Promise.resolve()
  };
}

test.before(async () => {
  if (skip) return;
  admin = await createPgPool({ connectionString: dbUrl, applicationName: 'mcp-db-tests', statementTimeoutMs: 30000 });
  const seed = readFileSync('db/v2/seed/002_demo_shop_seed.sql', 'utf8');
  const c = await admin.connect();
  try {
    await c.query(`SET demo.anchor_date = '${todayInTimezone()}';\n${seed}`);
  } finally {
    c.release();
  }
  await query(admin, "INSERT INTO tenants (id, name, status, processing_mode) VALUES ($1, 'DB Other Shop', 'active', 'v2') ON CONFLICT (id) DO NOTHING", [OTHER_TENANT]);
  await query(admin, "INSERT INTO shop_profiles (tenant_id, shop_name, display_currency) VALUES ($1, 'DB Other Shop', 'VND') ON CONFLICT (tenant_id) DO NOTHING", [OTHER_TENANT]);
  for (const [tenant, token] of [[DEMO_TENANT_ID, TOKEN_DEMO], [OTHER_TENANT, TOKEN_OTHER]]) {
    await query(admin, "INSERT INTO mcp_access_tokens (tenant_id, token_hash, label) VALUES ($1, $2, 'db-test') ON CONFLICT (token_hash) DO NOTHING", [tenant, sha(token)]);
  }
  srv = await startMcpServer({ store: new PgShopStore(runtimePool(admin)) });
  ({ client } = await connectClient(srv.url, TOKEN_DEMO));
});

test.after(async () => {
  if (skip) return;
  await client.close();
  await srv.close();
  await query(admin, 'DELETE FROM mcp_access_tokens WHERE token_hash = ANY($1)', [[sha(TOKEN_DEMO), sha(TOKEN_OTHER)]]);
  await query(admin, 'DELETE FROM shop_profiles WHERE tenant_id = $1', [OTHER_TENANT]);
  await query(admin, 'DELETE FROM tenants WHERE id = $1', [OTHER_TENANT]);
  await closePool(admin);
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });

test('read tools work on the Postgres demo seed through RLS', { skip }, async () => {
  const low = await call('get_low_stock');
  assert.ok(!low.isError, spoken(low));
  assert.deepEqual(low.structuredContent.items.map((i) => i.sku).sort(), ['BREAD-WHITE', 'COLA-330', 'EGG-10', 'MILK-1L']);

  const milk = await call('get_stock_level', { product: 'fresh milk 1l' });
  assert.equal(milk.structuredContent.product.sku, 'MILK-1L');
  const eggs = await call('get_stock_level', { product: 'eggs' });
  assert.equal(eggs.structuredContent.status, 'ambiguous');

  const sales = await call('get_sales_summary', { period: 'yesterday' });
  assert.ok(sales.structuredContent.units > 0);
  assert.ok(sales.structuredContent.comparison.revenue > 0);

  const top = await call('get_top_movers');
  assert.equal(top.structuredContent.items[0].sku, 'NOODLE-SHRIMP');

  const inv = await call('get_invoice_status');
  assert.deepEqual(inv.structuredContent.invoices.map((i) => i.status), ['mapped', 'arrived', 'synced']);

  const sugg = await call('suggest_reorder');
  assert.equal(sugg.structuredContent.item_count, 4);

  for (const r of [low, milk, eggs, sales, top, inv, sugg]) assert.ok(wordCount(spoken(r)) <= 35, spoken(r));
});

test('memory and Postgres stores agree on the same demo data', { skip }, async () => {
  const { MemoryShopStore } = await import('../../../apps/mcp-server/dist/memory-store.js');
  const { buildDemoDataset } = await import('../../../scripts/v2/gen_demo_seed.mjs');
  const mem = new MemoryShopStore(buildDemoDataset({ anchorDate: todayInTimezone(), tokens: { [TOKEN_DEMO]: DEMO_TENANT_ID } }));
  const memSrv = await startMcpServer({ store: mem });
  const { client: memClient } = await connectClient(memSrv.url, TOKEN_DEMO);
  try {
    for (const [name, args] of [['get_low_stock', {}], ['get_sales_summary', { period: 'last_7_days' }], ['suggest_reorder', {}], ['get_top_movers', {}]]) {
      const [a, b] = [await call(name, args), await memClient.callTool({ name, arguments: args })];
      assert.equal(spoken(a), spoken(b), `${name} differs between stores`);
    }
  } finally {
    await memClient.close();
    await memSrv.close();
  }
});

test('reorder two-step writes drafts under RLS; expiry enforced by the database clock', { skip }, async () => {
  const draft = await call('create_reorder_draft', { items: [{ product: 'milk' }, { product: 'eggs' }] });
  assert.equal(draft.structuredContent.status, 'draft_created');
  const token = draft.structuredContent.confirmation_token;
  const { rows } = await query(admin, 'SELECT status, created_via, confirmation_token_hash FROM purchase_order_drafts WHERE id = $1', [draft.structuredContent.drafts[0].draft_id]);
  assert.equal(rows[0].status, 'draft');
  assert.equal(rows[0].created_via, 'voice');
  assert.equal(rows[0].confirmation_token_hash, sha(token), 'only the hash is stored');

  const ok = await call('confirm_reorder', { confirmation_token: token });
  assert.equal(ok.structuredContent.status, 'confirmed');
  const after = await query(admin, 'SELECT status, confirmed_at FROM purchase_order_drafts WHERE id = $1', [draft.structuredContent.drafts[0].draft_id]);
  assert.equal(after.rows[0].status, 'confirmed');
  assert.ok(after.rows[0].confirmed_at);

  const second = await call('create_reorder_draft', { items: [{ product: 'bread' }] });
  await query(admin, "UPDATE purchase_order_drafts SET expires_at = now() - interval '1 second' WHERE id = $1", [second.structuredContent.drafts[0].draft_id]);
  const late = await call('confirm_reorder', { confirmation_token: second.structuredContent.confirmation_token });
  assert.equal(late.structuredContent.status, 'expired');
  const still = await query(admin, 'SELECT status FROM purchase_order_drafts WHERE id = $1', [second.structuredContent.drafts[0].draft_id]);
  assert.equal(still.rows[0].status, 'draft');
});

test('every tool call is audited with redacted args and latency', { skip }, async () => {
  const before = await query(admin, 'SELECT count(*)::int AS n FROM voice_audit_log WHERE tenant_id = $1', [DEMO_TENANT_ID]);
  await call('get_low_stock');
  await call('confirm_reorder', { confirmation_token: 'rc_audit_redaction_check' });
  const { rows } = await query(admin, 'SELECT tool_name, args_redacted, result_summary, latency_ms FROM voice_audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 2', [DEMO_TENANT_ID]);
  const after = await query(admin, 'SELECT count(*)::int AS n FROM voice_audit_log WHERE tenant_id = $1', [DEMO_TENANT_ID]);
  assert.equal(after.rows[0].n - before.rows[0].n, 2);
  const confirm = rows.find((r) => r.tool_name === 'confirm_reorder');
  assert.equal(confirm.args_redacted.confirmation_token, '[redacted]');
  assert.ok(rows.every((r) => r.latency_ms >= 0 && r.result_summary.length > 0));
});

test('tenant isolation over MCP: another tenant sees none of the demo shop', { skip }, async () => {
  const { client: other } = await connectClient(srv.url, TOKEN_OTHER);
  try {
    const low = await other.callTool({ name: 'get_low_stock', arguments: {} });
    assert.equal(low.structuredContent.total_low, 0);
    const milk = await other.callTool({ name: 'get_stock_level', arguments: { product: 'Fresh Milk 1L' } });
    assert.equal(milk.structuredContent.status, 'not_found');
    const inv = await other.callTool({ name: 'get_invoice_status', arguments: {} });
    assert.equal(inv.structuredContent.invoices.length, 0);
    const sales = await other.callTool({ name: 'get_sales_summary', arguments: { period: 'last_30_days' } });
    assert.equal(sales.structuredContent.units, 0);
  } finally {
    await other.close();
  }
});

test('revoked tokens stop working after the token cache TTL', { skip }, async () => {
  const token = 'sv_dbtest_revoke_token_000000000000000000000000';
  await query(admin, "INSERT INTO mcp_access_tokens (tenant_id, token_hash, label) VALUES ($1, $2, 'revoke-test')", [DEMO_TENANT_ID, sha(token)]);
  const shortCache = await startMcpServer({ store: new PgShopStore(runtimePool(admin)), env: { MCP_TOKEN_CACHE_SECONDS: '0' } });
  try {
    const init = () => fetch(`${shortCache.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    });
    assert.equal((await init()).status, 200);
    await query(admin, "UPDATE mcp_access_tokens SET status = 'revoked', revoked_at = now() WHERE token_hash = $1", [sha(token)]);
    assert.equal((await init()).status, 401);
  } finally {
    await shortCache.close();
    await query(admin, 'DELETE FROM mcp_access_tokens WHERE token_hash = $1', [sha(token)]);
  }
});
