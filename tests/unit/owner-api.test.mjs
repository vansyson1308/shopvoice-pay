// The console's owner API (MCP server /owner/api/*), the console routes that
// proxy it, the PayPal return pages, the simulated PayPal page (mock mode) and
// the PayPal webhook receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { MOCK_WEBHOOK_ID } from '../../apps/mcp-server/dist/owner-api.js';
import { createSimHandler, loadSimConfig } from '../../apps/console/dist/server.js';
import { localPath } from '../../apps/console/dist/owner-routes.js';
import { RulesBrain } from '../../apps/console/dist/brain.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { startMcpServer, connectClient, twoTenantDataset, mockPayments, silentLogger, TOKEN_A, TOKEN_B, DEMO_TENANT_ID, ANCHOR } from './mcp-harness.mjs';

const NOW = Date.parse(`${ANCHOR}T15:00:00Z`);
const clock = () => NOW;

async function stack({ connect = true } = {}) {
  const payments = mockPayments(clock, { CONSOLE_PUBLIC_URL: 'http://console.test' });
  const mcp = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments, connectTenants: connect ? [DEMO_TENANT_ID] : [] });
  const config = loadSimConfig({ SIM_MCP_URL: `${mcp.url}/mcp`, SIM_MCP_TOKEN: TOKEN_A, DEMO_ANCHOR_DATE: ANCHOR });
  const toolbox = new McpToolbox(config.mcpUrl, TOKEN_A);
  const handler = createSimHandler({
    config, logger: silentLogger, toolbox, brain: new RulesBrain(), fallbackBrain: new RulesBrain(), speech: new BrowserSpeech(),
    staticDir: fileURLToPath(new URL('../../apps/console/static/', import.meta.url))
  });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const consoleUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = async (method, path, body, token = TOKEN_A, headers = {}) => {
    const res = await fetch(`${mcp.url}/owner/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() };
  };
  const viaConsole = async (method, path, body) => {
    const res = await fetch(`${consoleUrl}${path}`, { method, redirect: 'manual', headers: { 'content-type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' }, ...(body ? { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return {
    mcp, payments, owner, viaConsole, consoleUrl,
    async close() {
      await toolbox.close();
      await new Promise((r) => server.close(r));
      await mcp.close();
    }
  };
}

async function heroOrder(mcpUrl) {
  const { client } = await connectClient(mcpUrl);
  try {
    const draft = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'milk' }, { product: 'eggs' }] } });
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: draft.structuredContent.confirmation_token } });
    return Object.fromEntries(r.structuredContent.payments.map((p) => [p.supplier_code, p]));
  } finally {
    await client.close();
  }
}

test('owner API: console credential only; OAuth tokens, browsers and strangers are refused', async () => {
  const s = await stack();
  try {
    assert.equal((await s.owner('GET', '/overview', null, '')).status, 401);
    assert.equal((await s.owner('GET', '/overview', null, 'sv_not_a_real_token_000000000000')).status, 401);
    assert.equal((await s.owner('GET', '/overview', null, 'svat_looks_like_an_oauth_access_token_0000')).status, 403);
    assert.equal((await s.owner('GET', '/overview', null, TOKEN_A, { origin: 'https://evil.example' })).status, 403);
    const ok = await s.owner('GET', '/overview');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.shop.name, "Maria's Corner Market (demo)");
    assert.equal(ok.json.paypal.mode, 'mock');
    assert.equal(ok.json.paypal.connected, true);
    assert.equal(ok.json.policy.per_order_autopay_max_minor, 10_000);
    // Tenant B's credential sees tenant B only.
    const other = await s.owner('GET', '/ledger', null, TOKEN_B);
    assert.equal(other.status, 200);
    assert.deepEqual(other.json.payments, []);
  } finally {
    await s.close();
  }
});

test('approvals: the console lists the step-up and approves it by tap; nothing secret is exposed', async () => {
  const s = await stack();
  try {
    const by = await heroOrder(s.mcp.url);
    const list = await s.viaConsole('GET', '/api/owner/approvals');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.approvals.map((a) => a.supplier_code), ['SUP-EGGS']);
    const card = list.json.approvals[0];
    assert.equal(card.amount_minor, 14_200);
    assert.ok(card.reasons.some((r) => r.code === 'price_jump'));
    assert.deepEqual(card.lines, [{ sku: 'EGGS-30', name: 'Large eggs 30 ct', qty: 10, unit_cost_minor: 1420 }]);
    for (const key of Object.keys(card)) assert.doesNotMatch(key, /paypal_order|authorization_id|capture|token_hash|vault/);

    const approved = await s.viaConsole('POST', `/api/owner/approvals/${by['SUP-EGGS'].payment_id}/approve`, { via: 'tap' });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.payment.status, 'authorized');
    assert.equal(approved.json.payment.approved_by, 'owner_tap');
    assert.equal(approved.json.payment.held_minor, 14_200);
    assert.ok(approved.json.payment.honor_period_ends_at && approved.json.payment.hold_expires_at);
    assert.equal(approved.json.paypal_url, null, 'a saved PayPal account needs no extra page');

    const twice = await s.viaConsole('POST', `/api/owner/approvals/${by['SUP-EGGS'].payment_id}/approve`, {});
    assert.equal(twice.status, 409, 'approving twice is refused');
    const autopaid = await s.viaConsole('POST', `/api/owner/approvals/${by['SUP-DAIRY'].payment_id}/decline`, {});
    assert.equal(autopaid.status, 409, 'an auto-paid order is not an approval');
    assert.deepEqual((await s.viaConsole('GET', '/api/owner/approvals')).json.approvals, []);
  } finally {
    await s.close();
  }
});

test('approvals: decline voids; the PayPal-page path returns through the simulated PayPal', async () => {
  const s = await stack();
  try {
    const first = await heroOrder(s.mcp.url);
    const declined = await s.viaConsole('POST', `/api/owner/approvals/${first['SUP-EGGS'].payment_id}/decline`, {});
    assert.equal(declined.json.payment.status, 'voided');

    // Same eggs again later (outside the duplicate window is not needed: the declined one is not live).
    const { client } = await connectClient(s.mcp.url);
    const draft = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'large eggs 30 ct', qty: 10 }] } });
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: draft.structuredContent.confirmation_token } });
    await client.close();
    const eggs = r.structuredContent.payments[0];
    assert.equal(eggs.status, 'pending_approval');

    const link = await s.viaConsole('POST', `/api/owner/approvals/${eggs.payment_id}/paypal`, {});
    assert.equal(link.status, 200, link.text);
    const approveUrl = new URL(link.json.approve_url);
    assert.equal(approveUrl.origin, 'http://console.test');
    assert.equal(approveUrl.pathname, '/sim/paypal/checkoutnow');

    const pageHtml = await s.viaConsole('GET', `${approveUrl.pathname}${approveUrl.search}`);
    assert.equal(pageHtml.status, 200);
    assert.match(pageHtml.text, /Simulated PayPal<\/strong> \(mock mode\)\. This is not PayPal and no money moves/);
    assert.match(pageHtml.text, /\$142\.00/);

    const decided = await s.viaConsole('POST', '/sim/paypal/decide', new URLSearchParams({ kind: 'order', id: approveUrl.searchParams.get('token'), action: 'approve' }));
    assert.equal(decided.status, 303);
    assert.match(decided.location, /^\/paypal\/approved\?payment=/, 'redirects stay on the console');
    const back = await s.viaConsole('GET', decided.location);
    assert.equal(back.location, '/?paypal=approved#approvals');
    const detail = await s.viaConsole('GET', `/api/owner/payments/${eggs.payment_id}`);
    assert.equal(detail.json.payment.status, 'authorized');
    assert.equal(detail.json.payment.approved_by, 'owner_paypal');
    assert.deepEqual(detail.json.events.map((e) => e.kind), ['policy_evaluated', 'approval_requested', 'approval_requested', 'authorized']);
  } finally {
    await s.close();
  }
});

test('Connect PayPal through the console: simulated approval, return page, connected', async () => {
  const s = await stack({ connect: false });
  try {
    assert.equal((await s.viaConsole('GET', '/api/owner/overview')).json.paypal.connected, false);
    const start = await s.viaConsole('POST', '/api/owner/paypal/connect', {});
    assert.equal(start.status, 200, start.text);
    const url = new URL(start.json.approve_url);
    assert.equal(url.pathname, '/sim/paypal/agreements/approve');
    const pageHtml = await s.viaConsole('GET', `${url.pathname}${url.search}`);
    assert.match(pageHtml.text, /Save PayPal for supplier payments/);
    const cancelled = await s.viaConsole('POST', '/sim/paypal/decide', new URLSearchParams({ kind: 'setup', id: url.searchParams.get('approval_session_id'), action: 'cancel' }));
    assert.match(cancelled.location, /^\/paypal\/cancelled\?method=/);
    const decided = await s.viaConsole('POST', '/sim/paypal/decide', new URLSearchParams({ kind: 'setup', id: url.searchParams.get('approval_session_id'), action: 'approve' }));
    assert.match(decided.location, /^\/paypal\/connected\?method=/);
    const back = await s.viaConsole('GET', decided.location);
    assert.equal(back.location, '/?paypal=connected#policy');
    const overview = await s.viaConsole('GET', '/api/owner/overview');
    assert.equal(overview.json.paypal.connected, true);
    assert.match(overview.json.paypal.account, /\*\*\*/);
  } finally {
    await s.close();
  }
});

test('policy and suppliers: the owner edits rules directly; invalid input is refused', async () => {
  const s = await stack();
  try {
    const raised = await s.viaConsole('PUT', '/api/owner/policy', { per_order_autopay_max_minor: 15_000, allow_listed_supplier_codes: ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY', 'SUP-HARBOR'] });
    assert.equal(raised.status, 200, raised.text);
    assert.equal(raised.json.policy.per_order_autopay_max_minor, 15_000);
    assert.equal((await s.viaConsole('PUT', '/api/owner/policy', { daily_hard_cap_minor: 100 })).status, 400);
    assert.equal((await s.viaConsole('PUT', '/api/owner/policy', { allow_listed_supplier_codes: ['SUP-NOPE'] })).status, 400);
    assert.equal((await s.viaConsole('PUT', '/api/owner/policy', { per_order_autopay_max_minor: 12.5 })).status, 400);

    const suppliers = await s.viaConsole('GET', '/api/owner/suppliers');
    assert.deepEqual(suppliers.json.suppliers.map((x) => [x.code, x.approved]).sort(), [['SUP-BAKERY', true], ['SUP-DAIRY', true], ['SUP-EGGS', true], ['SUP-HARBOR', true]]);
    const updated = await s.viaConsole('PUT', '/api/owner/suppliers/SUP-HARBOR', { paypal_email: 'Harbor.Billing@business.example.com', verified: true });
    assert.equal(updated.json.paypal_email, 'harbor.billing@business.example.com');
    assert.equal((await s.viaConsole('PUT', '/api/owner/suppliers/SUP-HARBOR', { paypal_email: 'not-an-email' })).status, 400);
    assert.equal((await s.viaConsole('PUT', '/api/owner/suppliers/SUP-NOPE', { paypal_email: 'a@b.co' })).status, 404);
  } finally {
    await s.close();
  }
});

test('delivery and refund from the console', async () => {
  const s = await stack();
  try {
    const by = await heroOrder(s.mcp.url);
    const id = by['SUP-DAIRY'].payment_id;
    const delivered = await s.viaConsole('POST', `/api/owner/payments/${id}/delivery`, { lines: [{ sku: 'MILK-WHOLE', received_qty: 10 }] });
    assert.equal(delivered.status, 200, delivered.text);
    assert.equal(delivered.json.outcome, 'partial');
    assert.equal(delivered.json.payment.charged_minor, 7000);
    assert.equal(delivered.json.payment.released_minor, 1400);
    assert.equal(delivered.json.supplier_paid_minor, 7000);
    const refund = await s.viaConsole('POST', `/api/owner/payments/${id}/refund`, { amount_minor: 700, reason: 'one crate spoiled' });
    assert.equal(refund.json.refunded_minor, 700);
    assert.equal((await s.viaConsole('POST', `/api/owner/payments/${id}/refund`, { amount_minor: 999_999, reason: 'too much' })).status, 409);
    assert.equal((await s.viaConsole('POST', `/api/owner/payments/${id}/delivery`, { all: true })).status, 409, 'nothing is held any more');
    const ledger = await s.viaConsole('GET', '/api/owner/ledger');
    assert.ok(ledger.json.payments.length >= 9, 'seeded history plus today');
    assert.ok(!/PAYID|paypal_authorization|capture_id/i.test(ledger.text));
  } finally {
    await s.close();
  }
});

test('webhook: verified events trigger a re-read from PayPal; forged, duplicate and unknown ones change nothing', async () => {
  const s = await stack();
  try {
    const by = await heroOrder(s.mcp.url);
    const id = by['SUP-DAIRY'].payment_id;
    const event = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'AUTH-X', custom_id: id, status: 'VOIDED' } });
    const post = (body, headers) => fetch(`${s.mcp.url}/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

    const forged = await post(event, { ...s.payments.runtime.mock.signWebhook(event, MOCK_WEBHOOK_ID), 'paypal-transmission-sig': 'forged' });
    assert.equal(forged.status, 400);
    assert.equal((await post(event, {})).status, 400, 'missing PayPal headers');

    const ok = await post(event, s.payments.runtime.mock.signWebhook(event, MOCK_WEBHOOK_ID));
    assert.deepEqual(await ok.json(), { status: 'processed' });
    const detail = await s.owner('GET', `/payments/${id}`);
    assert.equal(detail.json.payment.status, 'authorized', 'the payload said VOIDED, but PayPal still holds it: state follows PayPal, not the payload');
    assert.ok(detail.json.events.some((e) => e.kind === 'webhook_received'));

    const again = await post(event, s.payments.runtime.mock.signWebhook(event, MOCK_WEBHOOK_ID));
    assert.deepEqual(await again.json(), { status: 'duplicate' });
    const stranger = JSON.stringify({ id: 'WH-2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: '00000000-0000-4000-8000-000000000000' } });
    assert.deepEqual(await (await post(stranger, s.payments.runtime.mock.signWebhook(stranger, MOCK_WEBHOOK_ID))).json(), { status: 'ignored' });
  } finally {
    await s.close();
  }
});

test('console redirects never leave the console', () => {
  assert.equal(localPath('http://console.test/paypal/approved?payment=1'), '/paypal/approved?payment=1');
  assert.equal(localPath('https://evil.example/steal?x=1'), '/steal?x=1');
  assert.equal(localPath('//evil.example/x'), '/x');
  assert.equal(localPath(null), '/');
  assert.equal(localPath('javascript:alert(1)'), '/');
});
