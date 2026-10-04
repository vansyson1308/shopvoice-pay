// Console page delivery: per-request CSP nonce (AG Grid's styles are injected
// with it), the vendored AG Grid bundle, the QR endpoint's allow-list, and the
// offline rules brain's payment intents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { createSimHandler, loadSimConfig, qrAllowed, pageCsp } from '../../apps/console/dist/server.js';
import { planToolCall, RulesBrain } from '../../apps/console/dist/brain.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { startMcpServer, connectClient, twoTenantDataset, mockPayments, silentLogger, TOKEN_A, ANCHOR } from './mcp-harness.mjs';

async function consoleOnly() {
  const config = loadSimConfig({ SIM_MCP_URL: 'http://127.0.0.1:9/mcp', SIM_MCP_TOKEN: TOKEN_A });
  const handler = createSimHandler({ config, logger: silentLogger, toolbox: new McpToolbox(config.mcpUrl, TOKEN_A), brain: new RulesBrain(), fallbackBrain: new RulesBrain(), speech: new BrowserSpeech(), staticDir: fileURLToPath(new URL('../../apps/console/static/', import.meta.url)) });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('the console page gets a fresh CSP nonce; scripts stay same-origin', async () => {
  const s = await consoleOnly();
  try {
    const nonces = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${s.url}/`);
      const csp = res.headers.get('content-security-policy');
      const html = await res.text();
      const nonce = /<meta name="csp-nonce" content="([A-Za-z0-9+/=]{24})">/.exec(html)?.[1];
      assert.ok(nonce, 'nonce in the page');
      assert.equal(csp, pageCsp(nonce));
      assert.match(csp, /script-src 'self';/);
      assert.match(csp, new RegExp(`style-src-elem 'self' 'nonce-${nonce.replace(/[+/=]/g, '\\$&')}'`));
      assert.doesNotMatch(html, /__CSP_NONCE__/);
      nonces.push(nonce);
    }
    assert.notEqual(nonces[0], nonces[1]);
    const grid = await fetch(`${s.url}/static/vendor/ag-grid-community.min.js`);
    assert.equal(grid.status, 200);
    assert.match(grid.headers.get('content-type'), /javascript/);
    assert.match((await grid.text()).slice(0, 2000), /ag-grid|agGrid/i);
  } finally {
    await s.close();
  }
});

test('QR codes only for PayPal approval pages or the simulated PayPal page', async () => {
  assert.equal(qrAllowed('https://www.sandbox.paypal.com/checkoutnow?token=EXAMPLEORDER'), true);
  assert.equal(qrAllowed('/sim/paypal/checkoutnow?token=X'), true);
  assert.equal(qrAllowed('https://evil.example/checkoutnow'), false);
  assert.equal(qrAllowed('http://www.sandbox.paypal.com/checkoutnow'), false);
  assert.equal(qrAllowed('https://www.paypal.com.evil.example/'), false);
  assert.equal(qrAllowed('javascript:alert(1)'), false);
  const s = await consoleOnly();
  try {
    const ok = await fetch(`${s.url}/api/qr?url=${encodeURIComponent('https://www.sandbox.paypal.com/checkoutnow?token=ABC')}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
    assert.match(await ok.text(), /^<svg/);
    assert.equal((await fetch(`${s.url}/api/qr?url=${encodeURIComponent('https://evil.example/')}`)).status, 400);
  } finally {
    await s.close();
  }
});

test('rules brain: deliveries, payment status, spend, rules and "why"', () => {
  assert.deepEqual(planToolCall('Only 8 crates of milk came'), { name: 'record_delivery', input: { supplier: 'milk', items: [{ product: 'milk', received_qty: 8 }] } });
  assert.deepEqual(planToolCall('Twelve cases of eggs arrived'), { name: 'record_delivery', input: { supplier: 'eggs', items: [{ product: 'eggs', received_qty: 12 }] } });
  assert.deepEqual(planToolCall('The milk arrived'), { name: 'record_delivery', input: { supplier: 'milk', everything_arrived: true } });
  assert.deepEqual(planToolCall('Nothing came from the bakery'), { name: 'record_delivery', input: { supplier: 'bakery', nothing_arrived: true } });
  assert.equal(planToolCall('Did the Harbor Wholesale invoice arrive?').name, 'get_invoice_status', 'questions about invoices are not deliveries');
  assert.deepEqual(planToolCall('Why did the egg order need my OK?'), { name: 'explain_payment', input: { supplier: 'egg' } });
  assert.equal(planToolCall('What are my spending rules?').name, 'get_spending_policy');
  assert.equal(planToolCall('How much have I spent on suppliers this week?').name, 'get_spend_summary');
  assert.deepEqual(planToolCall('Did the eggs payment go through?'), { name: 'get_payment_status', input: { supplier: 'eggs' } });
});

test('record_delivery finds the open order by product ("the milk came"), not only by supplier name', async () => {
  const clock = () => Date.parse(`${ANCHOR}T15:00:00Z`);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments: mockPayments(clock) });
  const { client } = await connectClient(srv.url);
  try {
    const draft = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'milk' }] } });
    await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: draft.structuredContent.confirmation_token } });
    const r = await client.callTool({ name: 'record_delivery', arguments: { supplier: 'milk', items: [{ product: 'milk', received_qty: 8 }] } });
    assert.equal(r.structuredContent.status, 'recorded', r.content[0].text);
    assert.equal(r.structuredContent.charged, 56);
    assert.equal(r.structuredContent.payment.supplier_name, 'Northside Dairy');
  } finally {
    await client.close();
    await srv.close();
  }
});
