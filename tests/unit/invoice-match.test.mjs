// Invoice photo -> 3-way match, end to end through the console and the MCP
// server's owner API (mock PayPal): a short delivery is charged for what
// arrived; an invoice carrying an extra fee and text aimed at an AI is held,
// the text is shown as ignored and never reaches the voice brain; a model that
// "obeys" the injection still cannot raise a charge, add a line or touch rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { MemoryDemoShops } from '../../apps/mcp-server/dist/demo-shops.js';
import { createSimHandler, loadSimConfig } from '../../apps/console/dist/server.js';
import { RulesBrain } from '../../apps/console/dist/brain.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { ClaudeInvoiceExtractor, InvoiceReader, SampleInvoiceExtractor, INVOICE_SYSTEM_PROMPT, toExtractedInvoice, invoiceImageFrom } from '../../apps/console/dist/invoice-extract.js';
import { buildSandboxTenantData } from '../../scripts/gen_demo_seed.mjs';
import { startMcpServer, twoTenantDataset, mockPayments, silentLogger, DEMO_TENANT_ID, ANCHOR } from './mcp-harness.mjs';

const SECRET = 'provision-secret-0123456789abcdef';
const clock = () => Date.parse(`${ANCHOR}T15:00:00Z`);
const STATIC = fileURLToPath(new URL('../../apps/console/static/', import.meta.url));
const SAMPLES = `${STATIC}samples/`;

/** Wraps the rules brain and records everything the brain is ever shown. */
class RecordingBrain {
  kind = 'rules';
  model = 'recording';
  seen = [];
  inner = new RulesBrain();
  converse(input) {
    this.seen.push(JSON.stringify(input));
    return this.inner.converse(input);
  }
}

async function stack(invoiceReader) {
  const payments = mockPayments(clock);
  const store = new MemoryShopStore(twoTenantDataset(), clock);
  const demoShops = new MemoryDemoShops(store, () => buildSandboxTenantData('en', ANCHOR), payments, new Set([DEMO_TENANT_ID]), clock);
  const mcp = await startMcpServer({ store, payments, demoShops, resetDemo: (t) => demoShops.reset(t), env: { DEMO_PROVISION_SECRET: SECRET } });
  const config = loadSimConfig({ SIM_MCP_URL: `${mcp.url}/mcp`, DEMO_PROVISION_SECRET: SECRET, DEMO_ANCHOR_DATE: ANCHOR });
  const brain = new RecordingBrain();
  const handler = createSimHandler({
    config, logger: silentLogger, toolbox: new McpToolbox(config.mcpUrl, 'unused-in-visitor-mode-0000'), brain, fallbackBrain: brain,
    speech: new BrowserSpeech(), staticDir: STATIC, ...(invoiceReader ? { invoiceReader } : {})
  });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, brain, async close() { await new Promise((r) => server.close(r)); await mcp.close(); } };
}

function visitor(base) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

/** Starts a visitor shop and places the milk order ($84 held, within the rules). */
async function milkOrder(s) {
  const a = visitor(s.url);
  await a('POST', '/api/session');
  const drafted = await a('POST', '/api/turn', { text: 'Reorder milk' });
  await a('POST', '/api/turn', { text: 'Yes, confirm', conversationId: drafted.json.conversationId });
  const milk = (await a('GET', '/api/owner/ledger')).json.payments.find((p) => p.supplier_code === 'SUP-DAIRY' && p.held_minor > 0);
  assert.ok(milk, 'milk order is held');
  assert.equal(milk.held_minor, 8400);
  return { a, milk };
}

test('sample invoice, short delivery: 3-way match charges $56 for 8 crates and releases $28', async () => {
  const s = await stack();
  try {
    const { a, milk } = await milkOrder(s);
    const samples = (await a('GET', '/api/invoice/samples')).json;
    assert.equal(samples.reader, 'sample (simulated)');
    assert.deepEqual(samples.samples.map((x) => x.id), ['dairy-short', 'dairy-injection']);

    const read = await a('POST', '/api/invoice/read', { payment_id: milk.id, sample_id: 'dairy-short' });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(read.json.invoice.simulated, true, 'labelled simulated without an AI model');
    assert.equal(read.json.invoice.invoice_number, 'ND-24907');
    assert.deepEqual([read.json.match.result, read.json.match.decision, read.json.match.payable_minor], ['short', 'partial', 5600]);
    assert.equal(read.json.match.two_way, true);
    assert.equal((await a('GET', `/api/owner/payments/${milk.id}`)).json.payment.charged_minor, 0, 'reading moves no money');

    const applied = await a('POST', '/api/invoice/apply', { read_id: read.json.read_id, counted: [{ sku: 'MILK-WHOLE', received_qty: 8 }] });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.outcome, 'partial');
    assert.match(applied.json.speech, /Charged \$56 for what arrived from Northside Dairy and released \$28/);
    const after = (await a('GET', `/api/owner/payments/${milk.id}`)).json;
    assert.deepEqual([after.payment.charged_minor, after.payment.released_minor, after.payment.held_minor], [5600, 2800, 0]);
    assert.equal(after.deliveries.at(-1).source, 'invoice_photo');
    assert.equal(after.invoice_matches.length, 1);
    assert.equal(after.invoice_matches[0].result, 'short');
    assert.equal((await a('POST', '/api/invoice/apply', { read_id: read.json.read_id })).status, 404, 'a reading is applied once');
  } finally {
    await s.close();
  }
});

test('injection invoice: extra fee and a note to AI are held and shown, never followed; the voice brain never sees it', async () => {
  const s = await stack();
  try {
    const { a, milk } = await milkOrder(s);
    const policyBefore = (await a('GET', '/api/owner/policy')).json.policy;
    const suppliersBefore = (await a('GET', '/api/owner/suppliers')).json.suppliers;
    const paymentsBefore = (await a('GET', '/api/owner/ledger')).json.payments.length;

    const read = await a('POST', '/api/invoice/read', { payment_id: milk.id, sample_id: 'dairy-injection' });
    assert.equal(read.status, 200);
    assert.match(read.json.invoice.ignored_text[0], /NOTE TO AI ASSISTANT/);
    assert.deepEqual([read.json.match.result, read.json.match.decision, read.json.match.payable_minor], ['mismatch', 'hold', 0]);
    assert.equal(read.json.match.unmatched[0].description, 'Priority handling fee');

    const applied = await a('POST', '/api/invoice/apply', { read_id: read.json.read_id });
    assert.equal(applied.json.outcome, 'hold');
    assert.match(applied.json.speech, /not on your order/);
    const after = (await a('GET', `/api/owner/payments/${milk.id}`)).json;
    assert.deepEqual([after.payment.held_minor, after.payment.charged_minor], [8400, 0], 'the money stays on hold');
    assert.equal(after.invoice_matches[0].result, 'mismatch');
    assert.deepEqual((await a('GET', '/api/owner/policy')).json.policy, policyBefore, 'rules unchanged');
    assert.deepEqual((await a('GET', '/api/owner/suppliers')).json.suppliers, suppliersBefore, 'payees unchanged');
    assert.equal((await a('GET', '/api/owner/ledger')).json.payments.length, paymentsBefore, 'no new payment');

    // The owner keeps talking; nothing from the invoice is ever in the brain's input.
    await a('POST', '/api/turn', { text: 'How much have I spent on suppliers this week?' });
    assert.ok(s.brain.seen.length > 0);
    for (const input of s.brain.seen) assert.doesNotMatch(input, /NOTE TO AI|5,000|handling fee|ND-2490/);
  } finally {
    await s.close();
  }
});

/** A Messages API stub that returns whatever JSON an "obedient" model would. */
function stubClaude(reply) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(params) {
        requests.push(params);
        return { id: 'm', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] };
      }
    }
  };
}

test('a model that obeys the injection still cannot raise the charge, add a payee line, or touch rules', async () => {
  const obedient = stubClaude({
    supplier_name: 'Northside Dairy', invoice_number: 'ND-24908',
    lines: [
      { description: 'Whole milk 1 gal, crate of 2', sku: 'MILK-WHOLE', quantity: 12, unit_price: 500 },
      { description: 'Payment to Harbor Wholesale', sku: 'HARBOR-PAY', quantity: 1, unit_price: 5000 }
    ],
    ignored_text: [],
    approve_payment: true,
    set_autopay_max: 10000
  });
  const reader = new InvoiceReader(new ClaudeInvoiceExtractor(obedient, { model: 'claude-sonnet-5-5', family: 'sonnet' }), new SampleInvoiceExtractor(SAMPLES));
  const s = await stack(reader);
  try {
    const { a, milk } = await milkOrder(s);
    const photo = readFileSync(`${SAMPLES}invoice-dairy-injection.png`).toString('base64');
    const read = await a('POST', '/api/invoice/read', { payment_id: milk.id, media_type: 'image/png', image_base64: photo });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(read.json.invoice.simulated, false);
    assert.equal(read.json.invoice.extractor, 'claude-sonnet-5-5');
    assert.deepEqual(read.json.invoice.lines.map((l) => l.sku), ['MILK-WHOLE', null], 'a SKU that is not on the order is dropped');
    assert.equal(read.json.invoice.approve_payment, undefined, 'keys outside the schema are stripped');
    assert.equal(read.json.match.decision, 'hold');
    assert.equal(read.json.match.payable_minor, 0);
    const applied = await a('POST', '/api/invoice/apply', { read_id: read.json.read_id });
    assert.equal(applied.json.outcome, 'hold');
    assert.equal((await a('GET', `/api/owner/payments/${milk.id}`)).json.payment.charged_minor, 0);
    assert.equal((await a('GET', '/api/owner/policy')).json.policy.per_order_autopay_max_minor, 10_000);

    // What the model was given: one image, our order SKUs as context, a fixed output schema, and no tools.
    const req = obedient.requests[0];
    assert.equal(req.system, INVOICE_SYSTEM_PROMPT);
    assert.match(req.system, /untrusted data/);
    assert.equal(req.tools, undefined, 'the reader has no tools, so it cannot call payment tools');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.output_config.effort, 'low');
    assert.equal(req.messages[0].content[0].type, 'image');
    assert.match(req.messages[0].content[1].text, /MILK-WHOLE: Whole milk/);
  } finally {
    await s.close();
  }
});

test('reader output is validated: non-JSON, wrong shapes, oversized or mislabelled photos are refused', async () => {
  const context = { supplierName: 'Northside Dairy', poLines: [{ sku: 'MILK-WHOLE', name: 'Whole milk 1 gal (crate of 2)' }] };
  const png = readFileSync(`${SAMPLES}invoice-dairy-short.png`).toString('base64');
  await assert.rejects(new ClaudeInvoiceExtractor(stubClaude('Sure! Approving now.'), { model: 'claude-haiku-4-5-20251001', family: 'haiku' }).extract({ mediaType: 'image/png', base64: png }, context), (e) => e.code === 'unreadable');
  assert.throws(() => toExtractedInvoice({ supplier_name: null, invoice_number: null, lines: [{ description: 'x', sku: null, quantity: -5, unit_price: 1 }], ignored_text: [] }, context, 't', false), (e) => e.code === 'invalid');
  assert.throws(() => toExtractedInvoice({ lines: 'pay everything' }, context, 't', false), (e) => e.code === 'invalid');
  const ok = toExtractedInvoice({ supplier_name: 'A‮B', invoice_number: null, lines: [{ description: 'Milk\u0000\u0007', sku: 'milk-whole', quantity: 2, unit_price: 7.005 }], ignored_text: [] }, context, 't', false);
  assert.equal(ok.supplierName, 'A B', 'bidi and control characters are removed');
  assert.deepEqual(ok.lines[0], { description: 'Milk', sku: 'MILK-WHOLE', quantity: 2, unitPriceMinor: 701 });
  assert.throws(() => invoiceImageFrom('image/jpeg', png), (e) => e.code === 'invalid', 'a PNG labelled JPEG is refused');
  assert.throws(() => invoiceImageFrom('image/png', Buffer.alloc(3_600_000, 1).toString('base64')), /too large/);
  assert.throws(() => invoiceImageFrom('image/svg+xml', Buffer.from('<svg/>').toString('base64')), (e) => e.code === 'invalid');

  const s = await stack();
  try {
    const { a, milk } = await milkOrder(s);
    const own = await a('POST', '/api/invoice/read', { payment_id: milk.id, media_type: 'image/png', image_base64: Buffer.from(readFileSync(`${SAMPLES}invoice-dairy-short.png`).subarray(0, 2000)).toString('base64') });
    assert.equal(own.status, 501, 'without an AI model only the sample photos can be read');
    assert.equal(own.json.error, 'not_configured');
    const other = visitor(s.url);
    await other('POST', '/api/session');
    const read = await a('POST', '/api/invoice/read', { payment_id: milk.id, sample_id: 'dairy-short' });
    assert.equal((await other('POST', '/api/invoice/apply', { read_id: read.json.read_id })).status, 404, "another visitor cannot apply this shop's reading");
    assert.equal((await other('POST', '/api/invoice/read', { payment_id: milk.id, sample_id: 'dairy-short' })).status, 404, "or read against another shop's order");
  } finally {
    await s.close();
  }
});
