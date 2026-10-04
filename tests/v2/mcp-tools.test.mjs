// Tool contract tests over the real MCP protocol (SDK client -> Streamable
// HTTP -> ShopVoice server) using the in-memory demo dataset, so they run in
// CI without Postgres. tests/v2/db/mcp-tools-db.test.mjs repeats the key
// flows against Postgres + RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer, connectClient, spoken, wordCount, TOKEN_B } from './mcp-harness.mjs';

let srv;
let client;
let clockMs = Date.parse('2026-09-25T09:00:00Z');

test.before(async () => {
  const { MemoryShopStore } = await import('../../apps/mcp-server/dist/memory-store.js');
  const { twoTenantDataset } = await import('./mcp-harness.mjs');
  srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), () => clockMs) });
  ({ client } = await connectClient(srv.url));
});

test.after(async () => {
  await client.close();
  await srv.close();
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });

function assertVoiceContract(result, label) {
  assert.ok(!result.isError, `${label} returned an error: ${spoken(result)}`);
  const text = spoken(result);
  assert.ok(text.length > 0, `${label} has spoken text`);
  assert.ok(wordCount(text) <= 35, `${label} spoke ${wordCount(text)} words: ${text}`);
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${label} has structuredContent`);
  assert.doesNotMatch(text, /\d+\.\d{3,}/, `${label} should round numbers: ${text}`);
}

test('get_low_stock lists the 4 seeded low items, most urgent first, max 3 spoken', async () => {
  const r = await call('get_low_stock');
  assertVoiceContract(r, 'get_low_stock');
  const data = r.structuredContent;
  assert.equal(data.total_low, 4);
  assert.deepEqual(data.items.map((i) => i.sku).sort(), ['BREAD-WHITE', 'COLA-330', 'EGG-10', 'MILK-1L']);
  const covers = data.items.map((i) => i.days_of_cover);
  assert.deepEqual(covers, [...covers].sort((a, b) => a - b));
  assert.ok(data.items.every((i) => i.below_min && i.on_hand <= i.min_qty));
  assert.match(spoken(r), /^Four items are running low/);
  assert.match(spoken(r), /and 1 more/);
});

test('get_stock_level resolves exact names and barcodes, asks when ambiguous', async () => {
  const exact = await call('get_stock_level', { product: 'fresh milk 1l' });
  assertVoiceContract(exact, 'exact');
  assert.equal(exact.structuredContent.status, 'found');
  assert.equal(exact.structuredContent.product.sku, 'MILK-1L');
  assert.match(spoken(exact), /cartons of Fresh Milk 1L/);
  assert.match(spoken(exact), /below your minimum/);

  const barcode = await call('get_stock_level', { product: exact.structuredContent.product.sku === 'MILK-1L' ? '8931000000000' : 'x' });
  assert.equal(barcode.structuredContent.product?.sku, 'MILK-1L');

  const ambiguous = await call('get_stock_level', { product: 'eggs' });
  assertVoiceContract(ambiguous, 'ambiguous');
  assert.equal(ambiguous.structuredContent.status, 'ambiguous');
  assert.deepEqual(ambiguous.structuredContent.candidates.map((c) => c.sku).sort(), ['EGG-10', 'EGG-DUCK']);
  assert.match(spoken(ambiguous), /which one/i);

  const missing = await call('get_stock_level', { product: 'zzzz qqqq' });
  assert.equal(missing.structuredContent.status, 'not_found');
  assert.match(spoken(missing), /couldn't find/);
});

test('get_sales_summary: today vs last Friday, partial day, comparisons', async () => {
  const today = await call('get_sales_summary', { period: 'today', compare_weekday: 'friday' });
  assertVoiceContract(today, 'today');
  const d = today.structuredContent;
  assert.equal(d.period.start, '2026-09-25');
  assert.equal(d.period.partial, true);
  assert.equal(d.comparison.period.start, '2026-09-18', 'last Friday');
  assert.equal(d.currency, 'USD');
  assert.ok(d.revenue > 0 && d.units > 0);
  assert.equal(d.comparison.percent_of_comparison, Math.round((d.revenue_vnd / d.comparison.revenue_vnd) * 100));
  assert.match(spoken(today), /^So far today: \$\d/);
  assert.match(spoken(today), /last Friday/);

  const yesterday = await call('get_sales_summary', { period: 'yesterday' });
  assertVoiceContract(yesterday, 'yesterday');
  assert.equal(yesterday.structuredContent.comparison.period.start, '2026-09-17', 'same weekday last week');
  assert.match(spoken(yesterday), /^Yesterday: \$[\d,]+ from [\d,]+ items, (up|down|level)/);

  const custom = await call('get_sales_summary', { period: 'custom', start_date: '2026-09-01', end_date: '2026-09-07', compare_to: 'none' });
  assertVoiceContract(custom, 'custom');
  assert.equal(custom.structuredContent.comparison, null);
});

test('get_sales_summary rejects future or malformed custom ranges with a speakable error', async () => {
  const future = await call('get_sales_summary', { period: 'custom', start_date: '2027-01-01' });
  assert.equal(future.isError, true);
  assert.match(spoken(future), /valid date range/);
  assert.ok(wordCount(spoken(future)) <= 35);
  const malformed = await call('get_sales_summary', { period: 'custom', start_date: '25/09/2026' });
  assert.equal(malformed.isError, true, 'schema validation rejects non-ISO dates');
});

test('weekend spike is visible in the seeded sales', async () => {
  const sat = await call('get_sales_summary', { period: 'custom', start_date: '2026-09-19', compare_to: 'none' });
  const wed = await call('get_sales_summary', { period: 'custom', start_date: '2026-09-23', compare_to: 'none' });
  assert.ok(sat.structuredContent.revenue > wed.structuredContent.revenue * 1.2, 'Saturday > Wednesday by 20%+');
});

test('get_top_movers top and bottom', async () => {
  const top = await call('get_top_movers');
  assertVoiceContract(top, 'top');
  assert.equal(top.structuredContent.items.length, 3);
  assert.equal(top.structuredContent.items[0].sku, 'NOODLE-SHRIMP');
  const units = top.structuredContent.items.map((i) => i.units);
  assert.deepEqual(units, [...units].sort((a, b) => b - a));

  const bottom = await call('get_top_movers', { direction: 'bottom', metric: 'revenue', limit: 5 });
  assertVoiceContract(bottom, 'bottom');
  assert.equal(bottom.structuredContent.items.length, 5);
  assert.match(spoken(bottom), /^Slowest sellers/);
});

test('get_invoice_status: latest list and supplier filter', async () => {
  const all = await call('get_invoice_status');
  assertVoiceContract(all, 'all invoices');
  assert.deepEqual(all.structuredContent.invoices.map((i) => i.status), ['mapped', 'arrived', 'synced']);

  const bev = await call('get_invoice_status', { supplier: 'Sunrise Beverages' });
  assertVoiceContract(bev, 'beverages');
  assert.equal(bev.structuredContent.invoices[0].invoice_number, 'SRB-10442');
  assert.match(spoken(bev), /^Yes\. The Sunrise Beverages invoice/);
  assert.match(spoken(bev), /not synced/);

  const drinks = await call('get_invoice_status', { supplier: 'the drinks invoice' });
  assert.equal(drinks.structuredContent.invoices[0]?.supplier_code, 'SUP-BEV');

  const none = await call('get_invoice_status', { supplier: 'Acme Hardware' });
  assert.equal(none.structuredContent.matched, false);
  assert.match(spoken(none), /don't see a recent invoice/);
});

test('suggest_reorder: qty = (lead + 7) x avg - on hand, rounded to pack', async () => {
  const r = await call('suggest_reorder');
  assertVoiceContract(r, 'suggest_reorder');
  const lines = r.structuredContent.suppliers.flatMap((s) => s.lines.map((l) => ({ ...l, lead: s.lead_time_days })));
  assert.deepEqual(lines.map((l) => l.sku).sort(), ['BREAD-WHITE', 'COLA-330', 'EGG-10', 'MILK-1L']);
  for (const l of lines) {
    const needed = (l.lead + 7) * l.avg_daily_sales - l.on_hand;
    assert.equal(l.suggested_qty % l.pack_size, 0, `${l.sku} rounded to pack`);
    assert.ok(l.suggested_qty >= needed - 1 && l.suggested_qty < needed + l.pack_size + 1, `${l.sku} qty ${l.suggested_qty} vs needed ${needed}`);
  }
  assert.match(spoken(r), /Shall I draft/);
});

test('two-step reorder: "reorder milk and eggs" drafts low items, confirm is idempotent', async () => {
  const draft = await call('create_reorder_draft', { items: [{ product: 'milk' }, { product: 'eggs' }] });
  assertVoiceContract(draft, 'create_reorder_draft');
  const d = draft.structuredContent;
  assert.equal(d.status, 'draft_created');
  assert.match(d.confirmation_token, /^rc_[A-Za-z0-9_-]{16}$/);
  assert.equal(d.expires_in_seconds, 300);
  assert.equal(d.drafts.length, 1, 'milk and eggs share a supplier');
  assert.deepEqual(d.drafts[0].lines.map((l) => l.sku).sort(), ['EGG-10', 'MILK-1L'], 'ambiguous names resolve to the low items');
  assert.doesNotMatch(spoken(draft), new RegExp(d.confirmation_token), 'token is never spoken');
  assert.match(spoken(draft), /confirm/);

  const ok = await call('confirm_reorder', { confirmation_token: d.confirmation_token });
  assertVoiceContract(ok, 'confirm');
  assert.equal(ok.structuredContent.status, 'confirmed');
  assert.equal(ok.structuredContent.confirmed_count, 1);
  assert.match(spoken(ok), /^Done\./);

  const again = await call('confirm_reorder', { confirmation_token: d.confirmation_token });
  assert.equal(again.structuredContent.status, 'already_confirmed');

  const audit = srv.store.auditLog.filter((a) => a.toolName === 'confirm_reorder');
  assert.ok(audit.length >= 2);
  assert.equal(audit[0].argsRedacted.confirmation_token, '[redacted]', 'token never stored in the audit log');
});

test('confirmation token expires after 5 minutes', async () => {
  const draft = await call('create_reorder_draft', { items: [{ product: 'bread', qty: 20 }] });
  assert.equal(draft.structuredContent.status, 'draft_created');
  assert.equal(draft.structuredContent.drafts[0].lines[0].qty, 20);
  clockMs += 301_000;
  try {
    const late = await call('confirm_reorder', { confirmation_token: draft.structuredContent.confirmation_token });
    assertVoiceContract(late, 'expired confirm');
    assert.equal(late.structuredContent.status, 'expired');
    assert.match(spoken(late), /expired/);
  } finally {
    clockMs -= 301_000;
  }
  const bogus = await call('confirm_reorder', { confirmation_token: 'rc_not_a_real_token' });
  assert.equal(bogus.structuredContent.status, 'not_found');
});

test('create_reorder_draft asks instead of guessing when nothing disambiguates', async () => {
  const r = await call('create_reorder_draft', { items: [{ product: 'noodles' }] });
  assertVoiceContract(r, 'clarify');
  assert.equal(r.structuredContent.status, 'needs_clarification');
  assert.equal(r.structuredContent.confirmation_token, null);
  assert.equal(r.structuredContent.clarifications[0].candidates.length, 3);
  assert.match(spoken(r), /which one/);
});

test('create_reorder_draft with no items drafts all suggestions, one per supplier', async () => {
  const r = await call('create_reorder_draft');
  assertVoiceContract(r, 'draft all');
  assert.equal(r.structuredContent.drafts.length, 3);
  assert.ok(new Set(r.structuredContent.drafts.map((x) => x.draft_id)).size === 3);
});

test('get_daily_briefing is three short sentences', async () => {
  const r = await call('get_daily_briefing');
  assertVoiceContract(r, 'briefing');
  assert.equal(r.structuredContent.low_stock_count, 4);
  assert.equal(r.structuredContent.invoices_pending_sync, 2);
  assert.equal(spoken(r).split(/(?<=\.)\s/).length, 3);
});

test('invalid input is rejected by schema validation', async () => {
  const r = await call('get_top_movers', { limit: 99 });
  assert.equal(r.isError, true);
  const r2 = await call('get_stock_level', { product: 'x' });
  assert.equal(r2.isError, true);
  const r3 = await call('confirm_reorder', {});
  assert.equal(r3.isError, true);
});

test('every read tool stays within 35 spoken words across varied inputs', async () => {
  const inputs = [
    ['get_low_stock', {}], ['get_low_stock', { limit: 1 }],
    ...['milk', 'bread', 'cola', 'rice', 'beer', 'chips', 'water', 'fish sauce'].map((p) => ['get_stock_level', { product: p }]),
    ...['today', 'yesterday', 'this_week', 'last_week', 'last_7_days', 'last_30_days'].map((p) => ['get_sales_summary', { period: p }]),
    ...['today', 'yesterday', 'this_week', 'last_30_days'].map((p) => ['get_top_movers', { period: p, metric: 'revenue', limit: 10 }]),
    ['get_invoice_status', { limit: 10 }], ['get_invoice_status', { supplier: 'snacks' }],
    ['suggest_reorder', {}], ['suggest_reorder', { supplier: 'dairy' }], ['get_daily_briefing', {}]
  ];
  for (const [name, args] of inputs) {
    assertVoiceContract(await call(name, args), `${name} ${JSON.stringify(args)}`);
  }
});

test('tenant isolation: tenant B only sees its own shop', async () => {
  const { client: b } = await connectClient(srv.url, TOKEN_B);
  try {
    const low = await b.callTool({ name: 'get_low_stock', arguments: {} });
    assert.deepEqual(low.structuredContent.items.map((i) => i.sku), ['B-ONLY']);
    const milk = await b.callTool({ name: 'get_stock_level', arguments: { product: 'fresh milk 1l' } });
    assert.equal(milk.structuredContent.status, 'not_found');
    const inv = await b.callTool({ name: 'get_invoice_status', arguments: {} });
    assert.equal(inv.structuredContent.invoices.length, 0);
    // Tenant A's confirmation token is useless for tenant B.
    const draft = await call('create_reorder_draft', { items: [{ product: 'cola 330ml can' }] });
    const cross = await b.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: draft.structuredContent.confirmation_token } });
    assert.equal(cross.structuredContent.status, 'not_found');
    const profile = await b.readResource({ uri: 'shop://profile' });
    assert.equal(JSON.parse(profile.contents[0].text).shop_name, 'Other Shop');
  } finally {
    await b.close();
  }
});
