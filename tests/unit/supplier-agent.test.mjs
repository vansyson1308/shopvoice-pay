// The simulated supplier agent: the merchant side of PayPal's Cart API v1 spec
// (create, read, replace, check out; business problems as validation_issues;
// 400/404/422 as the spec uses them), called with RS256 JWTs scoped to one
// merchant, as PayPal calls merchants. Also the HTTP mount and JWKS endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKey, signJwt } from '../../packages/common/dist/index.js';
import { SupplierAgent, SUPPLIER_AGENT_AUDIENCE, demoCatalogs, fromMoney, toMoney } from '../../apps/supplier-agent/dist/index.js';
import { productFacts } from '../../apps/mcp-server/dist/supplier/supplier-orders.js';
import { loadSupplierAgents } from '../../apps/mcp-server/dist/supplier/setup.js';
import { SUPPLIERS, PRODUCTS } from '../../scripts/gen_demo_seed.mjs';
import { startMcpServer, mockPayments, silentLogger } from './mcp-harness.mjs';

const T0 = Date.parse('2026-10-20T15:00:00Z');
const buyer = generateSigningKey('buyer-test');
const tokenFor = (merchant, extra = {}, now = T0) => signJwt(buyer.privateKey, 'buyer-test', { iss: 'shopvoice-buyer-agent', aud: SUPPLIER_AGENT_AUDIENCE, merchant_id: merchant, scope: ['cart'], ...extra }, now);
const auth = (merchant, extra) => ({ authorization: `Bearer ${tokenFor(merchant, extra)}` });

function agent() {
  return new SupplierAgent(demoCatalogs(SUPPLIERS, PRODUCTS), () => [buyer.publicJwk], () => T0);
}

const eggs = (qty = 10) => [{ variant_id: 'EGGS-30', quantity: qty, price: toMoney(1420, 'USD') }];

test('auth: a bearer JWT for this merchant with the cart scope is required (RS256, unexpired, right audience)', async () => {
  const a = agent();
  const body = { items: eggs() };
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', {}, body)).status, 401);
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', auth('SUP-DAIRY'), body)).status, 403, 'token for another merchant');
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS', { scope: ['orders'] }), body)).status, 403, 'no cart scope');
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS', { aud: 'someone-else' }), body)).status, 401);
  const expired = signJwt(buyer.privateKey, 'buyer-test', { iss: 'x', aud: SUPPLIER_AGENT_AUDIENCE, merchant_id: 'SUP-EGGS', scope: ['cart'], ttlSeconds: 60 }, T0 - 3_600_000);
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', { authorization: `Bearer ${expired}` }, body)).status, 401);
  const stranger = generateSigningKey('buyer-test');
  const forged = signJwt(stranger.privateKey, 'buyer-test', { iss: 'x', aud: SUPPLIER_AGENT_AUDIENCE, merchant_id: 'SUP-EGGS', scope: ['cart'] }, T0);
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', { authorization: `Bearer ${forged}` }, body)).status, 401, 'signed by another key');
  const [h, p] = tokenFor('SUP-EGGS').split('.');
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', { authorization: `Bearer ${h}.${p}.` }, body)).status, 401, 'unsigned');
  assert.equal((await a.handle('SUP-NOPE', 'POST', '', auth('SUP-NOPE'), body)).status, 404);
});

test('out of stock: INCOMPLETE with ITEM_OUT_OF_STOCK and a suggested alternative; replacing the items makes it READY', async () => {
  const a = agent();
  const created = await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS'), { items: eggs() });
  assert.equal(created.status, 201, 'business problems still create the cart');
  const cart = created.json;
  assert.match(cart.id, /^CART-/);
  assert.deepEqual([cart.status, cart.validation_status], ['INCOMPLETE', 'INVALID']);
  const issue = cart.validation_issues[0];
  assert.equal(issue.code, 'INVENTORY_ISSUE');
  assert.equal(issue.type, 'BUSINESS_RULE');
  assert.equal(issue.variant_id, 'EGGS-30');
  assert.equal(issue.context.specific_issue, 'ITEM_OUT_OF_STOCK');
  assert.equal(issue.context.available_quantity, 0);
  assert.deepEqual(issue.context.suggested_alternatives, [{ variant_id: 'EGGS-15', name: 'Large eggs 15 ct', price: { currency_code: 'USD', value: '7.10' }, quantity: 20 }]);
  assert.deepEqual(issue.resolution_options.map((o) => o.action), ['SUGGEST_ALTERNATIVE', 'REMOVE_ITEM']);
  assert.equal(cart.totals.total.value, '142.00');

  const put = await a.handle('SUP-EGGS', 'PUT', `/${cart.id}`, auth('SUP-EGGS'), { items: [{ variant_id: 'EGGS-15', quantity: 20 }] });
  assert.equal(put.status, 200);
  assert.deepEqual([put.json.status, put.json.validation_status, put.json.validation_issues.length], ['READY', 'VALID', 0]);
  assert.equal(put.json.totals.total.value, '142.00', 'same total price');
  assert.deepEqual((await a.handle('SUP-EGGS', 'GET', `/${cart.id}`, auth('SUP-EGGS'))).json.items.map((i) => i.variant_id), ['EGGS-15']);
});

test('checkout: needs READY; returns the merchant order number; idempotent for the same PayPal order, refused for another', async () => {
  const a = agent();
  const cart = (await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS'), { items: eggs() })).json;
  const early = await a.handle('SUP-EGGS', 'POST', `/${cart.id}/checkout`, auth('SUP-EGGS'), { payment_method: { type: 'paypal', token: 'ORDER12345' } });
  assert.equal(early.status, 422);
  assert.equal(early.json.validation_issues[0].context.specific_issue, 'ITEM_OUT_OF_STOCK');
  await a.handle('SUP-EGGS', 'PUT', `/${cart.id}`, auth('SUP-EGGS'), { items: [{ variant_id: 'EGGS-15', quantity: 20 }] });
  assert.equal((await a.handle('SUP-EGGS', 'POST', `/${cart.id}/checkout`, auth('SUP-EGGS'), { payment_method: { type: 'card', token: 'x' } })).status, 400);
  const done = await a.handle('SUP-EGGS', 'POST', `/${cart.id}/checkout`, auth('SUP-EGGS'), { payment_method: { type: 'paypal', token: 'ORDER12345' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.status, 'COMPLETED');
  assert.match(done.json.payment_confirmation.merchant_order_number, /^EGGS-\d+$/);
  assert.match(done.json.payment_confirmation.order_review_page, /^https:\/\/sup-eggs\.supplier\.example\/orders\//);
  const again = await a.handle('SUP-EGGS', 'POST', `/${cart.id}/checkout`, auth('SUP-EGGS'), { payment_method: { type: 'paypal', token: 'ORDER12345' } });
  assert.equal(again.json.payment_confirmation.merchant_order_number, done.json.payment_confirmation.merchant_order_number);
  assert.equal((await a.handle('SUP-EGGS', 'POST', `/${cart.id}/checkout`, auth('SUP-EGGS'), { payment_method: { type: 'paypal', token: 'OTHER99999' } })).status, 422);
  assert.equal((await a.handle('SUP-EGGS', 'PUT', `/${cart.id}`, auth('SUP-EGGS'), { items: eggs() })).status, 422, 'a completed cart is final');
  assert.equal(a.catalog('SUP-EGGS').items.find((i) => i.variantId === 'EGGS-15').stock, null, 'unlimited stock stays unlimited');
});

test('spec errors: 400 malformed, 404 unknown or foreign cart, 422 when no cart can be created; PayPal-Request-Id makes create idempotent', async () => {
  const a = agent();
  for (const items of [undefined, [], [{ variant_id: 'EGGS-30', quantity: 0 }], [{ variant_id: 'EGGS 30;', quantity: 1 }], [{ variant_id: 'EGGS-30', quantity: 1, price: { currency_code: 'USD', value: '-1' } }]]) {
    assert.equal((await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS'), { items })).status, 400, JSON.stringify(items));
  }
  assert.equal((await a.handle('SUP-EGGS', 'POST', '', auth('SUP-EGGS'), { items: [{ variant_id: 'MILK-WHOLE', quantity: 1 }] })).status, 422, 'milk is not sold by the egg farm');
  assert.equal((await a.handle('SUP-EGGS', 'GET', '/CART-nope', auth('SUP-EGGS'))).status, 404);
  const dairyCart = (await a.handle('SUP-DAIRY', 'POST', '', auth('SUP-DAIRY'), { items: [{ variant_id: 'MILK-WHOLE', quantity: 12 }] })).json;
  assert.equal(dairyCart.status, 'READY');
  assert.equal((await a.handle('SUP-EGGS', 'GET', `/${dairyCart.id}`, auth('SUP-EGGS'))).status, 404, "one merchant cannot read another's cart");
  const h = { ...auth('SUP-DAIRY'), 'paypal-request-id': 'svp-cart-1' };
  const first = await a.handle('SUP-DAIRY', 'POST', '', h, { items: [{ variant_id: 'MILK-WHOLE', quantity: 12 }] });
  const second = await a.handle('SUP-DAIRY', 'POST', '', h, { items: [{ variant_id: 'MILK-WHOLE', quantity: 99 }] });
  assert.equal(second.json.id, first.json.id);
  assert.equal(second.json.items[0].quantity, 12, 'a replayed create returns the original cart');
});

test('price change: PRICING_ERROR / PRICE_MISMATCH with ACCEPT_NEW_PRICE when the buyer expects less than the current price', async () => {
  const a = agent();
  const cart = (await a.handle('SUP-DAIRY', 'POST', '', auth('SUP-DAIRY'), { items: [{ variant_id: 'MILK-WHOLE', quantity: 12, price: toMoney(650, 'USD') }] })).json;
  const issue = cart.validation_issues[0];
  assert.deepEqual([issue.code, issue.context.specific_issue], ['PRICING_ERROR', 'PRICE_MISMATCH']);
  assert.equal(fromMoney(issue.context.current_price), 700);
  assert.equal(fromMoney(issue.context.expected_price), 650);
  assert.equal(issue.resolution_options[0].action, 'ACCEPT_NEW_PRICE');
});

test('product facts come from our own catalog names', () => {
  assert.deepEqual(productFacts('Large eggs 30 ct'), { family: 'large eggs', baseUnits: 30 });
  assert.deepEqual(productFacts('Large eggs 15 ct'), { family: 'large eggs', baseUnits: 15 });
  assert.deepEqual(productFacts('Large eggs dozen'), { family: 'large eggs', baseUnits: 12 });
  assert.notEqual(productFacts('Brown eggs dozen').family, productFacts('Large eggs dozen').family);
  assert.deepEqual(productFacts('Whole milk 1 gal (crate of 2)'), { family: 'whole milk 1 gal', baseUnits: 2 });
  assert.deepEqual(productFacts('Fruit yogurt cups 4-pack'), { family: 'fruit yogurt cups', baseUnits: 4 });
});

test('HTTP: the MCP server serves the simulated agents at /supplier-agent and publishes the buyer JWKS', async () => {
  const payments = mockPayments();
  const suppliers = loadSupplierAgents({}, { SUPPLIERS, PRODUCTS }, silentLogger);
  const srv = await startMcpServer({ payments, suppliers });
  try {
    const jwks = await (await fetch(`${srv.url}/.well-known/buyer-agent-jwks.json`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].alg, 'RS256');
    assert.equal(jwks.keys[0].d, undefined, 'no private key material');
    const res = await fetch(`${srv.url}/supplier-agent/SUP-EGGS/merchant-cart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: eggs() }) });
    assert.equal(res.status, 401, 'the mounted agent requires the buyer JWT too');
    assert.equal(res.headers.get('x-simulated'), 'supplier-agent');
    assert.equal((await fetch(`${srv.url}/supplier-agent/SUP-EGGS/other`)).status, 404);
  } finally {
    await srv.close();
  }
  assert.throws(() => loadSupplierAgents({ SUPPLIER_AGENT_URL: 'https://agents.example' }, { SUPPLIERS, PRODUCTS }, silentLogger), /BUYER_AGENT_PRIVATE_KEY_PEM/);
  assert.equal(loadSupplierAgents({ SUPPLIER_AGENT_MODE: 'off' }, { SUPPLIERS, PRODUCTS }, silentLogger).orders, null);
});
