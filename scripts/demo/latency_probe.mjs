#!/usr/bin/env node
// Measures ShopVoice MCP tool latency (client-observed round trip over
// Streamable HTTP) for every read tool plus the reorder draft, and prints
// p50/p95/max per tool and overall. Optionally reads server-side latency from
// voice_audit_log when --database-url is given.
//
// Usage: node scripts/demo/latency_probe.mjs --mcp-url http://127.0.0.1:8090/mcp --token <bearer> [--rounds 20] [--pace-ms 0] [--database-url postgres://...] [--json-out file]
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

const CALLS = [
  ['get_low_stock', {}],
  ['get_stock_level', { product: 'fresh milk 1l' }],
  ['get_sales_summary', { period: 'today', compare_weekday: 'friday' }],
  ['get_top_movers', {}],
  ['get_invoice_status', { supplier: 'Sunrise Beverages' }],
  ['suggest_reorder', {}],
  ['get_daily_briefing', {}],
  ['create_reorder_draft', { items: [{ product: 'milk' }] }]
];

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const url = arg('--mcp-url', 'http://127.0.0.1:8090/mcp');
  const token = arg('--token', process.env.MCP_DEMO_TOKEN ?? '');
  const rounds = Number(arg('--rounds', '20'));
  // Stay under the server's per-tenant rate limit (default 120/min) on deployed stacks.
  const paceMs = Number(arg('--pace-ms', '0'));
  if (!token) throw new Error('--token (or MCP_DEMO_TOKEN) is required');

  const client = new Client({ name: 'latency-probe', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const samples = new Map(CALLS.map(([name]) => [name, []]));
  const startedAt = new Date();
  for (let r = 0; r < rounds; r += 1) {
    for (const [name, args] of CALLS) {
      const t0 = performance.now();
      const res = await client.callTool({ name, arguments: args });
      const ms = performance.now() - t0;
      if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
      if (r > 0) samples.get(name).push(ms); // round 0 = warm-up
      if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    }
  }
  await client.close();

  const all = [...samples.values()].flat();
  const report = {
    url,
    protocolVersion: transport.protocolVersion ?? null,
    rounds: rounds - 1,
    measuredAt: startedAt.toISOString(),
    perTool: Object.fromEntries([...samples].map(([name, v]) => [name, { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: percentile(v, 100) }])),
    overall: { n: all.length, p50: percentile(all, 50), p95: percentile(all, 95), max: percentile(all, 100) },
    target: { p95_ms: 800, met: (percentile(all, 95) ?? Infinity) < 800 }
  };

  const dbUrl = arg('--database-url');
  if (dbUrl) {
    const pg = (await import('pg')).default;
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
         FROM voice_audit_log WHERE created_at >= $1`, [startedAt]);
    await db.end();
    report.serverSideFromAuditLog = rows[0];
  }

  const out = arg('--json-out');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
