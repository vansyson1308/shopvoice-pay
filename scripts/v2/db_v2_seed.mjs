import { readFileSync } from 'node:fs';
import { runSql } from './db_v2_lib.mjs';
import { mintMcpToken } from './mcp_token_lib.mjs';
import { DEMO_TENANT_ID } from './gen_demo_seed.mjs';

const args = new Set(process.argv.slice(2));
const withDemo = args.has('--demo');

const sql = readFileSync('db/v2/seed/001_dev_seed.sql', 'utf8');
runSql(sql);
console.log('Applied V2 dev seed: db/v2/seed/001_dev_seed.sql');

if (withDemo) {
  const anchor = process.env.DEMO_ANCHOR_DATE ?? '';
  if (anchor && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    throw new Error('DEMO_ANCHOR_DATE must be YYYY-MM-DD');
  }
  const demoSql = readFileSync('db/v2/seed/002_demo_shop_seed.sql', 'utf8');
  // Session-level setting read by the seed's demo_anchor table.
  runSql(`SET demo.anchor_date = '${anchor}';\n${demoSql}`);
  console.log(`Applied ShopVoice demo seed: db/v2/seed/002_demo_shop_seed.sql (anchor=${anchor || 'today'})`);

  const { token, created } = mintMcpToken({
    tenantId: DEMO_TENANT_ID,
    label: 'demo',
    token: process.env.MCP_DEMO_TOKEN
  });
  if (created) {
    // Printed once so the operator can configure MCP clients; only the hash is stored.
    console.log(`ShopVoice demo MCP bearer token (tenant ${DEMO_TENANT_ID}): ${token}`);
  } else {
    console.log('ShopVoice demo MCP token from MCP_DEMO_TOKEN is registered.');
  }
}
