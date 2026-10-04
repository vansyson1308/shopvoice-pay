import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PayPalClient, PayPalApiError, PayPalTransportError, MockPayPal, MOCK_BASE_URL,
  assertNonLiveBaseUrl, redactPath, backoffMs, newRequestId,
  toPayPalValue, fromPayPalValue, formatMoney, speakMoney, sumMinor,
  createOrder, authorizeOrder, getOrder, firstAuthorization, captureAuthorization, voidAuthorization,
  reauthorize, getAuthorization, refundCapture, createSetupToken, createPaymentToken, getPaymentToken,
  createPayout, getPayoutBatch, verifyWebhookSignature, readWebhookHeaders, registerWebhook,
  buildOrderBody, findLink, loadPayPalConfig, createPayPalRuntime
} from '../../apps/mcp-server/dist/payments/index.js';

const USD = (amountMinor) => ({ amountMinor, currency: 'USD' });
const DAY = 86_400_000;

function setup(opts = {}) {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const mock = new MockPayPal({ now: clock.now, ...opts });
  const logs = [];
  const logger = {
    info: (message, context) => logs.push({ level: 'info', message, context }),
    warn: (message, context) => logs.push({ level: 'warn', message, context })
  };
  const client = new PayPalClient({ mode: 'mock', clientId: 'cid', clientSecret: 'csecret', baseUrl: MOCK_BASE_URL, fetch: mock.fetch, logger, sleep: async () => {}, now: clock.now });
  return { mock, client, logs, clock };
}

const unit = (amountMinor, extra = {}) => ({ referenceId: 'draft-1', description: 'Whole milk, 1 gal x 12', invoiceId: 'PO-1001', customId: 'pay_1', amount: USD(amountMinor), ...extra });

async function approvedAuthorization(ctx, amountMinor) {
  const order = await createOrder(ctx.client, {
    intent: 'AUTHORIZE',
    purchaseUnit: unit(amountMinor),
    paymentSource: { kind: 'paypal_approval', returnUrl: 'https://shop.example/return', cancelUrl: 'https://shop.example/cancel', brandName: 'ShopVoice Pay' },
    requestId: newRequestId('order')
  });
  ctx.mock.approveOrder(order.id);
  const authorized = await authorizeOrder(ctx.client, order.id, newRequestId('authorize'));
  return firstAuthorization(authorized);
}

test('money: minor units round-trip through PayPal decimal strings', () => {
  assert.equal(toPayPalValue(8400, 'USD'), '84.00');
  assert.equal(toPayPalValue(5, 'USD'), '0.05');
  assert.equal(toPayPalValue(500, 'JPY'), '500');
  assert.equal(fromPayPalValue('84.00', 'USD'), 8400);
  assert.equal(fromPayPalValue('84.5', 'USD'), 8450);
  assert.equal(fromPayPalValue('142', 'USD'), 14200);
  assert.throws(() => fromPayPalValue('84.001', 'USD'));
  assert.throws(() => fromPayPalValue('-1.00', 'USD'));
  assert.throws(() => toPayPalValue(1.5, 'USD'));
  assert.throws(() => toPayPalValue(100, 'VND'), /unsupported_currency/);
  assert.equal(formatMoney(USD(14200)), '$142.00');
  assert.equal(speakMoney(USD(14200)), '$142');
  assert.equal(speakMoney(USD(8450)), '$84.50');
  assert.equal(sumMinor([100, 250]), 350);
});

test('base URL guard: sandbox and local only, live PayPal refused', () => {
  assert.equal(assertNonLiveBaseUrl('https://api-m.sandbox.paypal.com'), 'https://api-m.sandbox.paypal.com');
  assert.equal(assertNonLiveBaseUrl(MOCK_BASE_URL), MOCK_BASE_URL);
  assert.throws(() => assertNonLiveBaseUrl('https://api-m.paypal.com'), /live_paypal_refused/);
  assert.throws(() => assertNonLiveBaseUrl('https://api.paypal.com'), /live_paypal_refused/);
  assert.throws(() => assertNonLiveBaseUrl('https://evil.example.com'), /not_allowed/);
  assert.throws(() => new PayPalClient({ mode: 'sandbox', clientId: '', clientSecret: 'x' }), /credentials_missing/);
});

test('config: defaults to mock, sandbox needs credentials, live is refused', () => {
  assert.equal(loadPayPalConfig({}).mode, 'mock');
  assert.equal(loadPayPalConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).mode, 'sandbox');
  assert.equal(loadPayPalConfig({ PAYPAL_MODE: 'mock', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).mode, 'mock');
  assert.throws(() => loadPayPalConfig({ PAYPAL_MODE: 'sandbox' }), /requires PAYPAL_CLIENT_ID/);
  assert.throws(() => loadPayPalConfig({ PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }), /sandbox-only/);
  const runtime = createPayPalRuntime({ PAYPAL_MODE: 'mock' });
  assert.ok(runtime.mock);
  assert.equal(runtime.client.mode, 'mock');
});

test('every POST carries a PayPal-Request-Id; POST without one is refused before sending', async () => {
  const ctx = setup();
  await approvedAuthorization(ctx, 8400);
  const posts = ctx.mock.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 3);
  for (const call of posts) assert.ok(call.requestId, `${call.path} lacks PayPal-Request-Id`);
  await assert.rejects(ctx.client.request({ method: 'POST', path: '/v2/checkout/orders', body: {} }), /paypal_request_id_required/);
});

test('access token is fetched once and reused', async () => {
  const ctx = setup();
  await approvedAuthorization(ctx, 1000);
  await approvedAuthorization(ctx, 2000);
  assert.equal(ctx.mock.calls.filter((c) => c.path === '/v1/oauth2/token').length, 1);
});

test('5xx is retried with the same PayPal-Request-Id and succeeds', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  ctx.mock.injectFault(503, 2, /\/capture$/);
  const capture = await captureAuthorization(ctx.client, auth.id, { finalCapture: true, requestId: 'cap-retry-1' });
  assert.equal(capture.status, 'COMPLETED');
  const captureCalls = ctx.mock.calls.filter((c) => c.path.endsWith('/capture'));
  assert.equal(captureCalls.length, 3);
  assert.deepEqual(new Set(captureCalls.map((c) => c.requestId)), new Set(['cap-retry-1']));
});

test('a lost capture response is retried with the same key and money moves once', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  ctx.mock.injectFault('drop_response', 1, /\/capture$/);
  const capture = await captureAuthorization(ctx.client, auth.id, { amount: USD(5000), finalCapture: false, requestId: 'cap-lost-1' });
  assert.equal(capture.amount.value, '50.00');
  const snapshot = ctx.mock.authorizationSnapshot(auth.id);
  assert.equal(snapshot.capturedMinor, 5000, 'captured exactly once');
  assert.equal(snapshot.captureIds.length, 1);
  const replays = ctx.mock.calls.filter((c) => c.path.endsWith('/capture') && c.replayed);
  assert.equal(replays.length, 1);
});

test('4xx business errors are not retried and surface PayPal issue codes', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  await captureAuthorization(ctx.client, auth.id, { finalCapture: true, requestId: 'cap-1' });
  await assert.rejects(
    captureAuthorization(ctx.client, auth.id, { finalCapture: true, requestId: 'cap-2' }),
    (error) => error instanceof PayPalApiError && error.status === 422 && error.code === 'AUTHORIZATION_ALREADY_CAPTURED'
  );
  assert.equal(ctx.mock.calls.filter((c) => c.requestId === 'cap-2').length, 1);
});

test('transport failure on every attempt raises PayPalTransportError carrying the request id', async () => {
  const ctx = setup();
  await ctx.client.accessToken();
  ctx.mock.injectFault('network', 3, /\/v2\/checkout\/orders$/);
  await assert.rejects(
    createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(100), paymentSource: { kind: 'paypal_approval', returnUrl: 'https://a.example/r', cancelUrl: 'https://a.example/c', brandName: 'x' }, requestId: 'order-net-1' }),
    (error) => error instanceof PayPalTransportError && error.requestId === 'order-net-1'
  );
});

test('401 refreshes the token once and replays the call', async () => {
  const ctx = setup();
  await ctx.client.accessToken();
  ctx.mock.injectFault(401, 1, /\/v2\/checkout\/orders$/);
  const order = await createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(100), paymentSource: { kind: 'paypal_approval', returnUrl: 'https://a.example/r', cancelUrl: 'https://a.example/c', brandName: 'x' }, requestId: 'order-401' });
  assert.equal(order.status, 'PAYER_ACTION_REQUIRED');
  assert.equal(ctx.mock.calls.filter((c) => c.path === '/v1/oauth2/token').length, 2);
});

test('logs carry status, debug id and redacted paths but never bodies, tokens or resource ids', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  await captureAuthorization(ctx.client, auth.id, { finalCapture: true, requestId: 'cap-log', correlationId: 'corr-123' });
  const serialized = JSON.stringify(ctx.logs);
  assert.ok(!serialized.includes(auth.id), 'authorization id leaked into logs');
  assert.ok(!serialized.includes('csecret'));
  assert.ok(!/A21AA[0-9a-f]{10}/.test(serialized), 'access token leaked into logs');
  assert.ok(!serialized.includes('84.00'), 'amounts/bodies are not logged');
  const capLog = ctx.logs.find((l) => l.context.correlation_id === 'corr-123');
  assert.equal(capLog.context.path, '/v2/payments/authorizations/{id}/capture');
  assert.ok(capLog.context.debug_id);
  assert.equal(redactPath('/v2/checkout/orders/5O190127TN364715T/authorize'), '/v2/checkout/orders/{id}/authorize');
  assert.equal(redactPath('/v3/vault/setup-tokens'), '/v3/vault/setup-tokens');
});

test('backoff is exponential, capped, and honours Retry-After', () => {
  assert.equal(backoffMs(1), 250);
  assert.equal(backoffMs(2), 500);
  assert.equal(backoffMs(9), 2000);
  assert.equal(backoffMs(1, '2'), 2000);
  assert.equal(backoffMs(1, '60'), 5000);
});

test('order body: third-party payee, items that must sum, vault source is merchant-initiated', () => {
  const body = buildOrderBody({
    intent: 'AUTHORIZE',
    purchaseUnit: unit(8400, { payee: { emailAddress: 'dairy@business.example.com' }, items: [{ name: 'Whole milk, 1 gal', sku: 'MILK-1G', quantity: 12, unitAmount: USD(700) }] }),
    paymentSource: { kind: 'vault', vaultId: 'v123' },
    requestId: 'x'
  });
  const pu = body.purchase_units[0];
  assert.deepEqual(pu.payee, { email_address: 'dairy@business.example.com' });
  assert.deepEqual(pu.amount, { currency_code: 'USD', value: '84.00', breakdown: { item_total: { currency_code: 'USD', value: '84.00' } } });
  assert.equal(pu.items[0].quantity, '12');
  assert.equal(body.payment_source.paypal.vault_id, 'v123');
  assert.equal(body.payment_source.paypal.stored_credential.payment_initiator, 'MERCHANT');
  assert.throws(() => buildOrderBody({ intent: 'AUTHORIZE', purchaseUnit: unit(9999, { items: [{ name: 'x', quantity: 1, unitAmount: USD(100) }] }), paymentSource: { kind: 'vault', vaultId: 'v' }, requestId: 'x' }), /order_items_do_not_sum/);
});

test('buyer-approval order: payer-action link, authorize only after approval', async () => {
  const ctx = setup();
  const order = await createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(14200), paymentSource: { kind: 'paypal_approval', returnUrl: 'https://a.example/r', cancelUrl: 'https://a.example/c', brandName: 'ShopVoice Pay' }, requestId: newRequestId('order') });
  assert.equal(order.status, 'PAYER_ACTION_REQUIRED');
  assert.match(findLink(order.links, 'payer-action', 'approve'), /checkoutnow\?token=/);
  await assert.rejects(authorizeOrder(ctx.client, order.id, newRequestId('auth')), (e) => e.code === 'ORDER_NOT_APPROVED');
  ctx.mock.approveOrder(order.id);
  const authorized = await authorizeOrder(ctx.client, order.id, newRequestId('auth'));
  const auth = firstAuthorization(authorized);
  assert.equal(authorized.status, 'COMPLETED');
  assert.equal(auth.status, 'CREATED');
  assert.equal(auth.amount.value, '142.00');
  assert.equal(Date.parse(auth.expiration_time) - Date.parse(auth.create_time), 29 * DAY);
  assert.equal((await getOrder(ctx.client, order.id)).status, 'COMPLETED');
});

test('authorization outcomes: full capture, partial + void, void', async () => {
  const ctx = setup();
  const full = await approvedAuthorization(ctx, 8400);
  const cap = await captureAuthorization(ctx.client, full.id, { finalCapture: true, requestId: newRequestId('cap') });
  assert.equal(cap.amount.value, '84.00');
  assert.equal((await getAuthorization(ctx.client, full.id)).status, 'CAPTURED');

  const partial = await approvedAuthorization(ctx, 12000);
  await captureAuthorization(ctx.client, partial.id, { amount: USD(10000), finalCapture: false, requestId: newRequestId('cap') });
  assert.equal((await getAuthorization(ctx.client, partial.id)).status, 'PARTIALLY_CAPTURED');
  await voidAuthorization(ctx.client, partial.id, newRequestId('void'));
  assert.equal((await getAuthorization(ctx.client, partial.id)).status, 'VOIDED');

  const finalPartial = await approvedAuthorization(ctx, 12000);
  await captureAuthorization(ctx.client, finalPartial.id, { amount: USD(10000), finalCapture: true, requestId: newRequestId('cap') });
  await assert.rejects(voidAuthorization(ctx.client, finalPartial.id, newRequestId('void')), (e) => e.code === 'AUTHORIZATION_ALREADY_CAPTURED');

  const voided = await approvedAuthorization(ctx, 5000);
  await voidAuthorization(ctx.client, voided.id, newRequestId('void'));
  await assert.rejects(captureAuthorization(ctx.client, voided.id, { finalCapture: true, requestId: newRequestId('cap') }), (e) => e.code === 'AUTHORIZATION_VOIDED');

  const over = await approvedAuthorization(ctx, 5000);
  await assert.rejects(captureAuthorization(ctx.client, over.id, { amount: USD(5001), finalCapture: true, requestId: newRequestId('cap') }), (e) => e.code === 'MAX_CAPTURE_AMOUNT_EXCEEDED');
});

test('honor period and expiry: reauthorize only after day 3, capture fails after day 29', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  await assert.rejects(reauthorize(ctx.client, auth.id, null, newRequestId('reauth')), (e) => e.code === 'REAUTHORIZATION_TOO_SOON');
  ctx.clock.advance(4 * DAY);
  const fresh = await reauthorize(ctx.client, auth.id, null, newRequestId('reauth'));
  assert.equal(fresh.status, 'CREATED');
  assert.notEqual(fresh.id, auth.id);
  ctx.clock.advance(26 * DAY);
  await assert.rejects(captureAuthorization(ctx.client, fresh.id, { finalCapture: true, requestId: newRequestId('cap') }), (e) => e.code === 'AUTHORIZATION_EXPIRED');
});

test('refunds: partial, then the rest, then nothing left', async () => {
  const ctx = setup();
  const auth = await approvedAuthorization(ctx, 8400);
  const cap = await captureAuthorization(ctx.client, auth.id, { finalCapture: true, requestId: newRequestId('cap') });
  const r1 = await refundCapture(ctx.client, cap.id, { amount: USD(1200), noteToPayer: 'Spoiled yogurt', requestId: newRequestId('refund') });
  assert.equal(r1.status, 'COMPLETED');
  assert.equal(r1.amount.value, '12.00');
  await assert.rejects(refundCapture(ctx.client, cap.id, { amount: USD(9000), requestId: newRequestId('refund') }), (e) => e.code === 'REFUND_AMOUNT_EXCEEDED');
  const r2 = await refundCapture(ctx.client, cap.id, { requestId: newRequestId('refund') });
  assert.equal(r2.amount.value, '72.00');
  await assert.rejects(refundCapture(ctx.client, cap.id, { requestId: newRequestId('refund') }), (e) => e.code === 'CAPTURE_FULLY_REFUNDED');
});

test('vault: save without purchase, then a merchant-initiated AUTHORIZE needs no buyer', async () => {
  const ctx = setup();
  const setupToken = await createSetupToken(ctx.client, { returnUrl: 'https://a.example/r', cancelUrl: 'https://a.example/c', brandName: 'ShopVoice Pay', description: 'Supplier payments for Corner Store', requestId: newRequestId('setup') });
  assert.equal(setupToken.status, 'PAYER_ACTION_REQUIRED');
  assert.ok(findLink(setupToken.links, 'approve'));
  await assert.rejects(createPaymentToken(ctx.client, setupToken.id, newRequestId('ptok')), (e) => e.code === 'SETUP_TOKEN_NOT_APPROVED');
  ctx.mock.approveSetupToken(setupToken.id);
  const paymentToken = await createPaymentToken(ctx.client, setupToken.id, newRequestId('ptok'));
  assert.ok(paymentToken.id);
  assert.ok(paymentToken.customer.id);
  assert.equal((await getPaymentToken(ctx.client, paymentToken.id)).id, paymentToken.id);

  const order = await createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(8400, { payee: { emailAddress: 'dairy@business.example.com' } }), paymentSource: { kind: 'vault', vaultId: paymentToken.id }, requestId: newRequestId('order') });
  assert.equal(order.status, 'COMPLETED');
  assert.equal(firstAuthorization(order).status, 'CREATED');
});

test('vault + third-party payee rejection is reported with PayPal issue code (fallback trigger)', async () => {
  const ctx = setup({ vaultThirdPartyPayee: 'rejected' });
  const st = await createSetupToken(ctx.client, { returnUrl: 'https://a.example/r', cancelUrl: 'https://a.example/c', brandName: 'x', description: 'x', requestId: newRequestId('setup') });
  ctx.mock.approveSetupToken(st.id);
  const pt = await createPaymentToken(ctx.client, st.id, newRequestId('ptok'));
  await assert.rejects(
    createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(8400, { payee: { emailAddress: 'dairy@business.example.com' } }), paymentSource: { kind: 'vault', vaultId: pt.id }, requestId: newRequestId('order') }),
    (e) => e.code === 'PAYEE_NOT_CONSENTED'
  );
  const platform = await createOrder(ctx.client, { intent: 'AUTHORIZE', purchaseUnit: unit(8400), paymentSource: { kind: 'vault', vaultId: pt.id }, requestId: newRequestId('order') });
  assert.equal(platform.status, 'COMPLETED');
});

test('payouts settle a supplier from the platform wallet; sender_batch_id is single-use', async () => {
  const ctx = setup();
  const batch = await createPayout(ctx.client, { senderBatchId: 'cap_123', emailSubject: 'Payment from Corner Store', items: [{ receiverEmail: 'dairy@business.example.com', amount: USD(8400), note: 'PO-1001', senderItemId: 'cap_123' }], requestId: newRequestId('payout') });
  assert.equal(batch.batch_header.batch_status, 'PENDING');
  const status = await getPayoutBatch(ctx.client, batch.batch_header.payout_batch_id);
  assert.equal(status.batch_header.batch_status, 'SUCCESS');
  await assert.rejects(createPayout(ctx.client, { senderBatchId: 'cap_123', emailSubject: 'x', items: [{ receiverEmail: 'a@b.example', amount: USD(1), note: 'x', senderItemId: 'x' }], requestId: newRequestId('payout') }), (e) => e.code === 'DUPLICATE_SENDER_BATCH_ID');
});

test('webhook verification: genuine event passes, tampered event and missing headers fail', async () => {
  const ctx = setup();
  // Deliberately odd spacing: verification must use the bytes as received, not a re-serialisation.
  const rawEvent = '{"id":"WH-EVT-1", "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP1","amount":{"currency_code":"USD","value":"84.00"}}}';
  const headers = readWebhookHeaders(ctx.mock.signWebhook(rawEvent, 'WH-123'));
  assert.ok(headers);
  assert.equal(await verifyWebhookSignature(ctx.client, { webhookId: 'WH-123', headers, rawEvent, requestId: newRequestId('whv') }), true);
  const tampered = rawEvent.replace('84.00', '8400.00');
  assert.equal(await verifyWebhookSignature(ctx.client, { webhookId: 'WH-123', headers, rawEvent: tampered, requestId: newRequestId('whv') }), false);
  assert.equal(await verifyWebhookSignature(ctx.client, { webhookId: 'WH-OTHER', headers, rawEvent, requestId: newRequestId('whv') }), false);
  await assert.rejects(verifyWebhookSignature(ctx.client, { webhookId: 'WH-123', headers, rawEvent: 'not json', requestId: newRequestId('whv') }));
  assert.equal(readWebhookHeaders({ 'paypal-transmission-id': 'x' }), null);
  const hook = await registerWebhook(ctx.client, 'https://shop.example/paypal/webhook', newRequestId('wh'));
  assert.equal(hook.event_types.length, 6);
});
