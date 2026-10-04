import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitMigration } from '../../scripts/db_lib.mjs';
import { buildCatalogue, buildPayees, buildSandboxCatalogue, renderSeedSql, SUPPLIERS, PRODUCTS, DEMO_POLICY } from '../../scripts/gen_demo_seed.mjs';
import { hashMcpToken, generateMcpToken } from '../../scripts/mcp_token_lib.mjs';

test('splitMigration accepts legacy files without migrate markers', () => {
  const legacy = 'ALTER TABLE a ADD b INT;\n\n---- rollback\nALTER TABLE a DROP b;\n';
  assert.deepEqual(splitMigration(legacy, 'x.sql'), { up: 'ALTER TABLE a ADD b INT;', down: 'ALTER TABLE a DROP b;' });
  assert.deepEqual(splitMigration('CREATE TABLE t (id INT);\n', 'y.sql'), { up: 'CREATE TABLE t (id INT);', down: '' });
  assert.throws(() => splitMigration('-- migrate:up\nSELECT 1;\n', 'z.sql'), /must contain/);
});

test('every existing migration splits into a non-empty up section', () => {
  for (const name of ['014_v2_pending_confirmations.sql', '015_v2_skipped_status.sql', '016_v2_miniapp_support.sql', '017_v2_inventory_sales.sql']) {
    const { up } = splitMigration(readFileSync(`db/migrations/${name}`, 'utf8'), name);
    assert.ok(up.length > 0, name);
  }
});

test('migration 017 enables and forces RLS on every new table', () => {
  const sql = readFileSync('db/migrations/017_v2_inventory_sales.sql', 'utf8');
  const { up, down } = splitMigration(sql, '017');
  for (const table of ['shop_profiles', 'suppliers', 'stock_levels', 'reorder_rules', 'sales_daily', 'purchase_order_drafts', 'voice_audit_log', 'mcp_access_tokens']) {
    assert.match(up, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(up, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(up, new RegExp(`CREATE POLICY rls_${table}_app_user ON ${table}`));
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table};`));
  }
});

test('demo catalogue is deterministic and matches the spec shape', () => {
  const a = buildCatalogue();
  const b = buildCatalogue();
  assert.deepEqual(a, b);
  assert.equal(a.length, 47);
  assert.equal(SUPPLIERS.length, 4);
  const low = a.filter((p) => p.onHand <= p.minQty).map((p) => p.sku);
  assert.deepEqual(low, ['MILK-WHOLE', 'EGGS-30', 'BREAD-WHITE', 'PAPER-TOWELS']);
  assert.equal(new Set(PRODUCTS.map((p) => p[0])).size, 47, 'SKUs must be unique');
  assert.deepEqual(SUPPLIERS.map((s) => s.code), ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY', 'SUP-HARBOR']);
  for (const p of a) {
    assert.equal(p.noise.length, 31);
    assert.ok(p.noise.every((n) => n >= 80 && n <= 120));
  }
});

test('demo seed is US-only and fictional: USD, example.com payees, hero prices', () => {
  const cat = buildSandboxCatalogue({});
  assert.equal(cat.profiles.en.display_currency, 'USD');
  assert.equal(cat.profiles.en.minor_per_unit, 100);
  assert.equal(cat.profiles.en.timezone, 'America/New_York');
  for (const p of cat.payees) assert.match(p.email, /@business\.example\.com$/, 'fictional payee emails only');
  assert.deepEqual(cat.policy.allow_listed, ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY'], 'Harbor Wholesale is not allow-listed');
  const byId = Object.fromEntries(cat.products.map((p) => [p.sku, p]));
  assert.equal(byId['MILK-WHOLE'].unit_cost * 12, 8400, 'hero: 12 crates of milk = $84.00');
  assert.equal(byId['EGGS-30'].unit_cost * 10, 14200, 'hero: 10 cases of eggs = $142.00');
  assert.ok(14200 > DEMO_POLICY.perOrderAutopayMaxMinor, 'the egg order needs step-up approval');
  assert.ok(8400 <= DEMO_POLICY.perOrderAutopayMaxMinor, 'the milk order can autopay');
  const lastEgg = cat.prices.filter((r) => r.sku === 'EGGS-30').sort((a, b) => a.days_ago - b.days_ago)[0];
  assert.ok(byId['EGGS-30'].unit_cost / lastEgg.unit_cost > 1 + DEMO_POLICY.priceJumpPct / 100, 'egg price jump trips the anomaly check');
  const sql = renderSeedSql();
  assert.doesNotMatch(sql, /VND|dong|Ho_Chi_Minh|KiotViet/i);
});

test('sandbox supplier emails from env override the fictional ones in order', () => {
  const payees = buildPayees({ SANDBOX_SUPPLIER_EMAIL: 'a@x.example.com', SANDBOX_SUPPLIER_EMAILS: 'b@x.example.com, c@x.example.com' });
  assert.deepEqual(payees.map((p) => p.email), ['a@x.example.com', 'b@x.example.com', 'c@x.example.com', SUPPLIERS[3].email]);
});

test('committed demo seed SQL is up to date with the generator', () => {
  const committed = readFileSync('db/seed/002_demo_shop_seed.sql', 'utf8');
  assert.equal(committed, renderSeedSql(), 'run: node scripts/gen_demo_seed.mjs > db/seed/002_demo_shop_seed.sql');
});

test('MCP tokens are high-entropy and hashed with SHA-256 hex', () => {
  const t1 = generateMcpToken();
  const t2 = generateMcpToken();
  assert.notEqual(t1, t2);
  assert.match(t1, /^sv_[A-Za-z0-9_-]{43}$/);
  assert.match(hashMcpToken(t1), /^[0-9a-f]{64}$/);
});
