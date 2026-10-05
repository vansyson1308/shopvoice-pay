// PayPal Agent Toolkit behind the policy layer (DECISIONS D19). The real
// @paypal/agent-toolkit code runs in every test: in mock mode it calls a
// loopback bridge into MockPayPal. Covers the allow-list and request ids,
// shipment tracking after a charge, the ledger-vs-PayPal cross-check, the
// two-step catering invoice, and that no PayPal capture or invoice id reaches
// tool output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createPayPalRuntime } from '../../apps/mcp-server/dist/payments/index.js';
import { createToolkitRunner, startMockToolkitBridge, TOOLKIT_DENIED, ToolkitError } from '../../apps/mcp-server/dist/toolkit/agent-toolkit.js';
import { ToolkitGateway, loadToolkitGatewayConfig, recipientAllowed, cleanText, ToolkitPolicyError } from '../../apps/mcp-server/dist/toolkit/toolkit-gateway.js';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { autoCommitRepository } from '../../apps/mcp-server/dist/auto-commit.js';
import { startMcpServer, connectClient, twoTenantDataset, mockPayments, spoken, wordCount, DEMO_TENANT_ID, TOKEN_B, ANCHOR } from './mcp-harness.mjs';

const NOW = Date.parse(`${ANCHOR}T15:00:00Z`);
const clock = () => NOW;

function invoiceArgs(number) {
  return {
    currency_code: 'USD', invoice_number: number,
    primary_recipients: [{ billing_info: { email_address: 'jordan@personal.example.com' } }],
    items: [{ name: 'Sandwich platter', quantity: '2', unit_amount: { currency_code: 'USD', value: '45.00' } }]
  };
}

// ---------- the runner: allow-list and PayPal-Request-Id ----------

test('runner: only allow-listed toolkit methods run, and every POST needs a PayPal-Request-Id', async () => {
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' });
  const runner = createToolkitRunner(runtime);
  for (const method of ['create_refund', 'get_merchant_insights', 'create_order', 'pay_order', 'capture_order', 'list_disputes']) {
    await assert.rejects(runner.run(method, {}, 'svp-x'), (e) => e instanceof ToolkitError && e.code === 'toolkit_method_denied', method);
  }
  assert.match(TOOLKIT_DENIED.create_refund, /PaymentsService/);
  assert.match(TOOLKIT_DENIED.get_merchant_insights, /sandbox/);
  await assert.rejects(runner.run('create_invoice', invoiceArgs('N-0')), (e) => e.code === 'paypal_request_id_required');
  await assert.rejects(runner.run('create_shipment_tracking', { transaction_id: 'X', tracking_number: 'T', status: 'DELIVERED', carrier: 'OTHER' }), (e) => e.code === 'paypal_request_id_required');
  assert.equal(runtime.mock.calls.filter((c) => c.path !== '/v1/oauth2/token').length, 0, 'nothing reached PayPal');
});

test('runner: the real toolkit sends our request id; a replay with the same key creates nothing new', async () => {
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' });
  const runner = createToolkitRunner(runtime);
  const first = await runner.run('create_invoice', invoiceArgs('N-1'), 'svp-inv-N-1');
  const again = await runner.run('create_invoice', invoiceArgs('N-1'), 'svp-inv-N-1');
  assert.equal(again.href, first.href, 'same key, same invoice');
  const posts = runtime.mock.calls.filter((c) => c.path === '/v2/invoicing/invoices');
  assert.deepEqual(posts.map((c) => [c.requestId, c.replayed]), [['svp-inv-N-1', false], ['svp-inv-N-1', true]]);
  // A PayPal error comes back as a ToolkitError with the HTTP status, not as data.
  await assert.rejects(runner.run('get_invoice', { invoice_id: 'INV2-AAAA-BBBB-CCCC-DDDD' }), (e) => e instanceof ToolkitError && e.status === 404);
  // A different key for the same invoice number is refused by PayPal (duplicate number).
  await assert.rejects(runner.run('create_invoice', invoiceArgs('N-1'), 'svp-inv-other'), (e) => e.status === 422);
});

test('mock bridge: loopback only, and only under its random path', async () => {
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' });
  const bridge = await startMockToolkitBridge(runtime.mock);
  try {
    const url = new URL(bridge.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/[0-9a-f]{24}$/);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: url.port, path: '/v1/reporting/transactions', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 404, 'no prefix, no PayPal');
  } finally {
    await bridge.close();
  }
});

// ---------- the gateway's bounds ----------

function gatewayFor(store, runtime, env = {}) {
  const runner = createToolkitRunner(runtime);
  const gateway = new ToolkitGateway(runner, loadToolkitGatewayConfig(env), clock);
  const ctx = { repo: autoCommitRepository(store, DEMO_TENANT_ID).payments, correlationId: 'test', supplierName: (c) => c };
  return { gateway, ctx };
}

test('catering invoices: sandbox recipients only, bounded items and totals, text cleaned', async () => {
  assert.equal(recipientAllowed('jordan@personal.example.com', ['example.com']), true);
  assert.equal(recipientAllowed('chef@example.com', ['example.com']), true);
  for (const bad of ['someone@gmail.com', 'x@example.com.evil.net', 'x@notexample.com', 'no-at-sign', 'a@b@example.com']) assert.equal(recipientAllowed(bad, ['example.com']), false, bad);
  assert.equal(cleanText('Platter‮ moc.liame\u0007  for 10', 80), 'Platter moc.liame for 10');
  // CATERING_RECIPIENT_DOMAINS accepts reserved test domains only.
  assert.deepEqual(loadToolkitGatewayConfig({ CATERING_RECIPIENT_DOMAINS: 'shop.test,gmail.com,customers.example' }).recipientDomains.slice(3), ['shop.test', 'customers.example']);

  const store = new MemoryShopStore(twoTenantDataset(), clock);
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' }, { now: clock });
  const { gateway, ctx } = gatewayFor(store, runtime, { CATERING_INVOICE_MAX_USD: '300', CATERING_INVOICES_PER_DAY: '2' });
  const base = { customerEmail: 'jordan@personal.example.com', customerName: null, note: '', currency: 'USD', createdBy: 'agent' };
  const refused = async (input, code) => assert.rejects(gateway.prepareCatering(ctx, { ...base, ...input }), (e) => e instanceof ToolkitPolicyError && e.code === code, code);
  await refused({ customerEmail: 'real.person@gmail.com', items: [{ name: 'Tray', qty: 1, unitPriceMinor: 4500 }] }, 'recipient_not_allowed');
  await refused({ items: [{ name: 'Tray', qty: 7, unitPriceMinor: 4500 }] }, 'over_invoice_limit');
  await refused({ items: [] }, 'invalid_items');
  await refused({ items: Array.from({ length: 11 }, () => ({ name: 'Tray', qty: 1, unitPriceMinor: 100 })) }, 'invalid_items');
  await refused({ items: [{ name: 'Tray', qty: 0, unitPriceMinor: 100 }] }, 'invalid_items');
  await refused({ items: [{ name: 'Tray', qty: 1, unitPriceMinor: 50_001 }] }, 'invalid_items');
  assert.equal(runtime.mock.calls.length, 0, 'refusals never reach PayPal');

  const draft = await gateway.prepareCatering(ctx, { ...base, items: [{ name: 'Sandwich platter⁦', qty: 2, unitPriceMinor: 4500 }] });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.totalMinor, 9000);
  assert.equal(draft.lines[0].name, 'Sandwich platter');
  assert.equal(runtime.mock.calls.length, 0, 'a draft is not sent');
  // Daily limit counts sent invoices.
  for (let i = 0; i < 2; i += 1) {
    const d = await gateway.prepareCatering(ctx, { ...base, items: [{ name: 'Fruit tray', qty: 1, unitPriceMinor: 3000 }] });
    await gateway.sendCatering(ctx, d.id, 'Corner Market');
  }
  await refused({ items: [{ name: 'Fruit tray', qty: 1, unitPriceMinor: 3000 }] }, 'daily_limit');
});

test('catering send: a failure after create is retried with the same keys, never a second invoice', async () => {
  const store = new MemoryShopStore(twoTenantDataset(), clock);
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' }, { now: clock });
  const { gateway, ctx } = gatewayFor(store, runtime);
  const draft = await gateway.prepareCatering(ctx, { customerEmail: 'jordan@personal.example.com', customerName: 'Jordan Lee', items: [{ name: 'Sandwich platter', qty: 2, unitPriceMinor: 4500 }], note: 'Saturday pickup', currency: 'USD', createdBy: 'agent' });
  runtime.mock.injectFault(500, 1, /\/send$/);
  await assert.rejects(gateway.sendCatering(ctx, draft.id, 'Corner Market'), ToolkitError);
  const failed = await ctx.repo.getSalesInvoice(draft.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.paypalInvoiceId, 'the PayPal invoice id is kept for the retry');
  const sent = await gateway.sendCatering(ctx, draft.id, 'Corner Market');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.paypalInvoiceId, failed.paypalInvoiceId);
  const creates = runtime.mock.calls.filter((c) => c.path === '/v2/invoicing/invoices' && c.status === 201 && !c.replayed);
  assert.equal(creates.length, 1, 'one PayPal invoice');
  assert.ok(runtime.mock.calls.filter((c) => c.path.endsWith('/send')).every((c) => c.requestId === `${draft.paypalRequestId}-send`));
  // Sending again is a no-op.
  assert.equal((await gateway.sendCatering(ctx, draft.id, 'Corner Market')).status, 'sent');
  assert.equal(runtime.mock.calls.filter((c) => c.path.endsWith('/send') && c.status === 200).length, 1);
});

// ---------- through MCP: tracking, cross-check, catering ----------

async function fullDelivery(client) {
  const draft = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'milk' }] } });
  const confirmed = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: draft.structuredContent.confirmation_token } });
  assert.equal(confirmed.structuredContent.payments[0].status, 'authorized', spoken(confirmed));
  const delivered = await client.callTool({ name: 'record_delivery', arguments: { supplier: 'milk', everything_arrived: true } });
  assert.equal(delivered.structuredContent.outcome, 'full', spoken(delivered));
  return confirmed.structuredContent.payments[0].payment_id;
}

test('MCP: a charged delivery gets PayPal tracking; the cross-check matches; no capture id reaches the model', async () => {
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  const outputs = [];
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
    assert.ok(!r.isError, `${name}: ${spoken(r)}`);
    assert.ok(wordCount(spoken(r)) <= 35, `${name}: ${spoken(r)}`);
    return r;
  };
  try {
    const before = await call('check_paypal_records');
    assert.equal(before.structuredContent.status, 'nothing_to_check');

    const paymentId = await fullDelivery(client);
    const record = await srv.store.withTenant(DEMO_TENANT_ID, (repo) => repo.payments.getPayment(paymentId));
    const captureId = record.paypalCaptureIds[0];
    const events = await srv.store.withTenant(DEMO_TENANT_ID, (repo) => repo.payments.listEvents(paymentId));
    const tracked = events.find((e) => e.kind === 'shipment_tracked');
    assert.ok(tracked, 'tracking recorded in the ledger');
    assert.equal(tracked.paypalRequestId, `svp-track-${captureId}`);
    assert.equal(tracked.paypalResourceId, captureId);
    const trackPosts = payments.runtime.mock.calls.filter((c) => c.path === '/v1/shipping/trackers-batch');
    assert.deepEqual(trackPosts.map((c) => c.requestId), [`svp-track-${captureId}`]);

    const tracking = await call('get_delivery_tracking', { supplier: 'dairy' });
    assert.equal(tracking.structuredContent.status, 'tracked');
    assert.equal(tracking.structuredContent.trackers[0].status, 'DELIVERED');
    assert.match(spoken(tracking), /delivered, tracking SVP-/);
    assert.equal(payments.runtime.mock.calls.filter((c) => c.path === '/v1/shipping/trackers-batch').length, 1, 'already tracked: no second POST');

    const check = await call('check_paypal_records', { days: 7 });
    assert.equal(check.structuredContent.status, 'match', spoken(check));
    assert.equal(check.structuredContent.ledger_count, 1);
    assert.equal(check.structuredContent.ledger_total, 84);
    assert.match(spoken(check), /match the ledger/);

    const explain = await call('explain_payment', { payment_id: paymentId });
    assert.ok(explain.structuredContent.events.some((e) => e.kind === 'shipment_tracked'));

    for (const out of outputs) assert.ok(!out.includes(captureId), 'capture id leaked to tool output');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('MCP: PayPal search lag is reported as lag, not as a mismatch', async () => {
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  try {
    await fullDelivery(client);
    // Same ledger, but PayPal's search has not caught up with the last 3 hours.
    payments.runtime.mock.reportingLagMs = 3 * 3600_000;
    const r = await client.callTool({ name: 'check_paypal_records', arguments: {} });
    assert.equal(r.structuredContent.status, 'lagging', spoken(r));
    assert.equal(r.structuredContent.not_yet_listed, 1);
    assert.match(spoken(r), /lag/);
  } finally {
    await client.close();
    await srv.close();
  }
});

test('MCP: catering invoice needs the confirmation token; a forged, stale or other-shop token sends nothing', async () => {
  let now = NOW;
  const tick = () => now;
  const payments = mockPayments(tick);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), tick), payments, connectTenants: [DEMO_TENANT_ID] });
  const { client } = await connectClient(srv.url);
  const { client: other } = await connectClient(srv.url, TOKEN_B);
  const mock = payments.runtime.mock;
  const sends = () => mock.calls.filter((c) => c.path.endsWith('/send') && !c.replayed).length;
  try {
    const preview = await client.callTool({ name: 'create_catering_invoice', arguments: { customer_email: 'jordan@personal.example.com', customer_name: 'Jordan Lee', items: [{ description: 'Sandwich platter, serves 10', quantity: 2, unit_price: 45 }], note: 'Saturday pickup' } });
    const p = preview.structuredContent;
    assert.equal(p.status, 'needs_confirmation', spoken(preview));
    assert.equal(p.total, 90);
    assert.match(spoken(preview), /Invoice j\*\*\*n@personal\.example\.com \$90 for 2 × Sandwich platter, serves 10 through PayPal\? Say "confirm"/);
    assert.ok(wordCount(spoken(preview)) <= 35);
    assert.ok(!JSON.stringify(preview).includes('jordan@'), 'the email is masked');
    assert.equal(mock.calls.filter((c) => c.path.startsWith('/v2/invoicing')).length, 0, 'preview sends nothing');

    const token = p.confirmation_token;
    const [prefix, id, exp, mac] = token.split('.');
    const forged = `${prefix}.${id}.${exp}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await client.callTool({ name: 'create_catering_invoice', arguments: { confirmation_token: forged } })).structuredContent.status, 'invalid');
    assert.equal((await other.callTool({ name: 'create_catering_invoice', arguments: { confirmation_token: token } })).structuredContent.status, 'invalid', 'another shop cannot use it');
    assert.equal(sends(), 0);

    const sent = await client.callTool({ name: 'create_catering_invoice', arguments: { confirmation_token: token } });
    assert.equal(sent.structuredContent.status, 'sent', spoken(sent));
    assert.equal(sent.structuredContent.invoice.status, 'sent');
    assert.match(spoken(sent), /\$90 catering invoice is on its way/);
    assert.equal(sends(), 1);
    const row = await srv.store.withTenant(DEMO_TENANT_ID, (repo) => repo.payments.getSalesInvoice(id));
    assert.ok(row.paypalInvoiceId);
    assert.ok(!JSON.stringify(sent).includes(row.paypalInvoiceId), 'PayPal invoice id stays on the server');

    // The same token again does not send twice.
    await client.callTool({ name: 'create_catering_invoice', arguments: { confirmation_token: token } });
    assert.equal(sends(), 1);

    const list = await client.callTool({ name: 'get_catering_invoices', arguments: {} });
    assert.match(spoken(list), /\$90 to Jordan Lee, waiting for payment/);
    mock.payInvoice(row.paypalInvoiceId);
    const paid = await client.callTool({ name: 'get_catering_invoices', arguments: {} });
    assert.equal(paid.structuredContent.invoices[0].status, 'paid');
    assert.match(spoken(paid), /paid/);

    // A token outlives its 5 minutes.
    const second = await client.callTool({ name: 'create_catering_invoice', arguments: { customer_email: 'chef@business.example.com', items: [{ description: 'Fruit tray', quantity: 1, unit_price: 30 }] } });
    now += 6 * 60_000;
    const late = await client.callTool({ name: 'create_catering_invoice', arguments: { confirmation_token: second.structuredContent.confirmation_token } });
    assert.equal(late.structuredContent.status, 'expired');
    assert.equal(sends(), 1);

    // Bounds hold through the tool too.
    const real = await client.callTool({ name: 'create_catering_invoice', arguments: { customer_email: 'someone@gmail.com', items: [{ description: 'Tray', quantity: 1, unit_price: 30 }] } });
    assert.equal(real.structuredContent.status, 'refused');
    assert.match(spoken(real), /sandbox customers only/);
    const big = await client.callTool({ name: 'create_catering_invoice', arguments: { customer_email: 'chef@business.example.com', items: [{ description: 'Tray', quantity: 300, unit_price: 45 }] } });
    assert.equal(big.structuredContent.status, 'refused');
    assert.match(spoken(big), /over the \$1,000 catering invoice limit/);
  } finally {
    await client.close();
    await other.close();
    await srv.close();
  }
});

test('MCP: the toolkit can be switched off (PAYPAL_TOOLKIT=off)', async () => {
  const payments = mockPayments(clock, { PAYPAL_TOOLKIT: 'off' });
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  try {
    const paymentId = await fullDelivery(client);
    const events = await srv.store.withTenant(DEMO_TENANT_ID, (repo) => repo.payments.listEvents(paymentId));
    assert.ok(!events.some((e) => e.kind === 'shipment_tracked'));
    const r = await client.callTool({ name: 'create_catering_invoice', arguments: { customer_email: 'chef@business.example.com', items: [{ description: 'Tray', quantity: 1, unit_price: 30 }] } });
    assert.equal(r.structuredContent.status, 'not_set_up');
  } finally {
    await client.close();
    await srv.close();
  }
});

// ---------- the voice console host ----------

/** A brain that calls one tool on its own (as if steered by injected text), then speaks. */
class ScriptedBrain {
  kind = 'rules';
  model = 'scripted';
  constructor(name, input) { this.name = name; this.input = input; this.calls = 0; }
  async converse({ messages }) {
    const last = messages[messages.length - 1];
    if (last.content.some((b) => 'toolResult' in b)) return { content: [{ text: 'Done.' }], stopReason: 'end_turn', latencyMs: 0 };
    this.calls += 1;
    return { content: [{ toolUse: { toolUseId: `s-${this.calls}`, name: this.name, input: this.input } }], stopReason: 'tool_use', latencyMs: 0 };
  }
}

test('console: the host holds the invoice token; a yes sends it; the model cannot invoice or confirm on its own', async () => {
  const { runTurn, newConversation } = await import('../../apps/console/dist/agent.js');
  const { RulesBrain } = await import('../../apps/console/dist/brain.js');
  const { McpToolbox } = await import('../../apps/console/dist/toolbox.js');
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const toolbox = new McpToolbox(`${srv.url}/mcp`, 'sv_test_demo_tenant_token_aaaaaaaaaaaaaaaaaaaaaaaa');
  const sends = () => payments.runtime.mock.calls.filter((c) => c.path.endsWith('/send')).length;
  const turn = (conversation, userText, brain = new RulesBrain()) => runTurn({ conversation, userText, brain, toolbox, today: ANCHOR, now: clock });
  try {
    const c = newConversation('c1', NOW);
    const preview = await turn(c, 'Invoice jordan@personal.example.com for two sandwich platters at $45');
    assert.match(preview.reply, /Invoice j\*\*\*n@personal\.example\.com \$90 for 2 × sandwich platter through PayPal\? Say "confirm"/);
    assert.equal(preview.toolCalls[0].structured.confirmation_token, '[held by host]', 'the model never sees the token');
    assert.ok(c.heldTokens.create_catering_invoice?.startsWith('ci.'));
    const sent = await turn(c, 'Yes, send it');
    assert.equal(sent.toolCalls[0].name, 'create_catering_invoice');
    assert.equal(sent.toolCalls[0].args.confirmation_token, '[held by host]');
    assert.match(sent.reply, /\$90 catering invoice is on its way/);
    assert.equal(sends(), 1);
    assert.equal(c.heldTokens.create_catering_invoice, undefined, 'used once');

    // Injected text makes the model try to invoice during an unrelated request: the host refuses.
    const rogue = new ScriptedBrain('create_catering_invoice', { customer_email: 'attacker@business.example.com', items: [{ description: 'Gift card', quantity: 10, unit_price: 100 }] });
    const blocked = await turn(newConversation('c2', NOW), "What's running low?", rogue);
    assert.match(blocked.toolCalls[0].blockedByHost, /did not ask to invoice/);
    // And it cannot confirm a preview without the owner's yes, whatever token it sends.
    const c3 = newConversation('c3', NOW);
    await turn(c3, 'Invoice jordan@personal.example.com for a fruit tray at $30');
    const noYes = await turn(c3, 'What is the weather like', new ScriptedBrain('create_catering_invoice', { confirmation_token: 'ci.forged.token.value' }));
    assert.match(noYes.toolCalls[0].blockedByHost, /has not said yes/);
    assert.equal(sends(), 1, 'nothing else was sent');

    // PayPal fails after the yes: the host keeps the token, and the next yes retries with the same keys.
    const c4 = newConversation('c4', NOW);
    await turn(c4, 'Invoice jordan@personal.example.com for a cookie box at $12');
    payments.runtime.mock.injectFault(500, 1, /\/send$/);
    const failed = await turn(c4, 'Yes');
    assert.match(failed.reply, /nothing was sent/);
    assert.ok(c4.heldTokens.create_catering_invoice, 'token kept for the retry');
    const retried = await turn(c4, 'Yes, confirm');
    assert.match(retried.reply, /\$12 catering invoice is on its way/);
    assert.equal(payments.runtime.mock.calls.filter((c) => c.path === '/v2/invoicing/invoices' && !c.replayed && c.status === 201).length, 2, 'two invoices in total, not three');
  } finally {
    await toolbox.close();
    await srv.close();
  }
});

test('mock mode: loopback is exempted from an HTTP proxy, so the bridge never goes through one', async () => {
  const { exemptLoopbackFromProxy } = await import('../../apps/mcp-server/dist/toolkit/agent-toolkit.js');
  const env = { http_proxy: 'http://proxy.internal:3128', no_proxy: 'localhost' };
  exemptLoopbackFromProxy(env);
  assert.equal(env.no_proxy, 'localhost,127.0.0.1');
  assert.equal(env.NO_PROXY, '127.0.0.1');
  exemptLoopbackFromProxy(env);
  assert.equal(env.no_proxy, 'localhost,127.0.0.1', 'idempotent');
  const none = {};
  exemptLoopbackFromProxy(none);
  assert.deepEqual(none, {}, 'no proxy, no change');
});
