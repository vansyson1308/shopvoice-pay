import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitMigration } from '../../scripts/v2/db_v2_lib.mjs';
import { buildCatalogue, renderSeedSql, SUPPLIERS, PRODUCTS } from '../../scripts/v2/gen_demo_seed.mjs';
import { hashMcpToken, generateMcpToken } from '../../scripts/v2/mcp_token_lib.mjs';

test('splitMigration accepts legacy files without migrate markers', () => {
  const legacy = 'ALTER TABLE a ADD b INT;\n\n---- rollback\nALTER TABLE a DROP b;\n';
  assert.deepEqual(splitMigration(legacy, 'x.sql'), { up: 'ALTER TABLE a ADD b INT;', down: 'ALTER TABLE a DROP b;' });
  assert.deepEqual(splitMigration('CREATE TABLE t (id INT);\n', 'y.sql'), { up: 'CREATE TABLE t (id INT);', down: '' });
  assert.throws(() => splitMigration('-- migrate:up\nSELECT 1;\n', 'z.sql'), /must contain/);
});

test('every existing migration splits into a non-empty up section', () => {
  for (const name of ['014_v2_pending_confirmations.sql', '015_v2_skipped_status.sql', '016_v2_miniapp_support.sql', '017_v2_inventory_sales.sql']) {
    const { up } = splitMigration(readFileSync(`db/v2/migrations/${name}`, 'utf8'), name);
    assert.ok(up.length > 0, name);
  }
});

test('migration 017 enables and forces RLS on every new table', () => {
  const sql = readFileSync('db/v2/migrations/017_v2_inventory_sales.sql', 'utf8');
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
  assert.equal(a.length, 60);
  assert.equal(SUPPLIERS.length, 5);
  const low = a.filter((p) => p.onHand <= p.minQty).map((p) => p.sku);
  assert.deepEqual(low, ['MILK-1L', 'EGG-10', 'BREAD-WHITE', 'COLA-330']);
  assert.equal(new Set(PRODUCTS.map((p) => p[0])).size, 60, 'SKUs must be unique');
  for (const p of a) {
    assert.equal(p.noise.length, 91);
    assert.ok(p.noise.every((n) => n >= 80 && n <= 120));
  }
});

test('committed demo seed SQL is up to date with the generator', () => {
  const committed = readFileSync('db/v2/seed/002_demo_shop_seed.sql', 'utf8');
  assert.equal(committed, renderSeedSql(), 'run: node scripts/v2/gen_demo_seed.mjs > db/v2/seed/002_demo_shop_seed.sql');
});

test('MCP tokens are high-entropy and hashed with SHA-256 hex', () => {
  const t1 = generateMcpToken();
  const t2 = generateMcpToken();
  assert.notEqual(t1, t2);
  assert.match(t1, /^sv_[A-Za-z0-9_-]{43}$/);
  assert.match(hashMcpToken(t1), /^[0-9a-f]{64}$/);
});
