import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentsService, PaymentFlowError, PayPalClient, MockPayPal, MOCK_BASE_URL, maskEmail, sha256Hex
} from '../../apps/mcp-server/dist/payments/index.js';
import { MemoryPaymentsData, MemoryPaymentsRepository } from '../../apps/mcp-server/dist/ledger/index.js';
import { DEFAULT_POLICY } from '../../apps/mcp-server/dist/policy/index.js';

const DAY = 86_400_000;
const MEK = Buffer.alloc(32, 9).toString('base64');
const SUPPLIERS = { 'SUP-DAIRY': 'Northside Dairy', 'SUP-EGGS': 'Valley Farm Eggs', 'SUP-BAKERY': 'Hillside Bakery', 'SUP-NEW': 'Harbor Wholesale' };

function world({ connect = true } = {}) {
  let now = Date.parse('2026-10-06T23:30:00Z');
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const mock = new MockPayPal({ now: clock.now, approveBaseUrl: 'https://www.sandbox.paypal.com' });
  const client = new PayPalClient({ mode: 'mock', clientId: 'c', clientSecret: 's', baseUrl: MOCK_BASE_URL, fetch: mock.fetch, sleep: async () => {}, now: clock.now });
  const day = (offset) => new Date(now + offset * DAY).toISOString().slice(0, 10);
  const data = new MemoryPaymentsData({
    policy: { ...DEFAULT_POLICY, allowListedSupplierIds: ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY'] },
    payees: [
      { supplierCode: 'SUP-DAIRY', paypalEmail: 'dairy@business.example.com', paypalMerchantId: null, currency: 'USD', verified: true },
      { supplierCode: 'SUP-EGGS', paypalEmail: 'eggs@business.example.com', paypalMerchantId: null, currency: 'USD', verified: true },
      { supplierCode: 'SUP-BAKERY', paypalEmail: 'bakery@business.example.com', paypalMerchantId: null, currency: 'USD', verified: true }
    ],
    prices: [
      ...[-25, -15, -5].map((d) => ({ supplierCode: 'SUP-DAIRY', sku: 'MILK-1G', unitCostMinor: 700, currency: 'USD', observedOn: day(d) })),
      ...[-24, -12, -4].map((d) => ({ supplierCode: 'SUP-EGGS', sku: 'EGGS-30', unitCostMinor: 1085, currency: 'USD', observedOn: day(d) }))
    ],
    pastQuantities: { 'MILK-1G': [12, 12, 10], 'EGGS-30': [10, 10, 12] }
  });
  const repo = new MemoryPaymentsRepository(data, clock.now);
  const service = new PaymentsService(client, { brandName: 'ShopVoice Pay', returnBaseUrl: 'https://console.example', mekB64: MEK, approvalTtlSeconds: 600, timeZone: 'America/New_York' }, clock.now);
  const ctx = { repo, correlationId: 'corr-test', supplierName: (c) => SUPPLIERS[c] ?? c };
  // Pretend a few past orders were completed with each supplier (not first orders).
  for (const code of ['SUP-DAIRY', 'SUP-EGGS']) {
    data.payments.set(`past-${code}`, { id: `past-${code}`, draftId: null, supplierCode: code, currency: 'USD', status: 'captured', decision: 'autopay', decisionReasons: [], linesFingerprint: `past-${code}`, lines: [], createdBy: 'agent', approvedBy: null, requestedMinor: 1000, authorizedMinor: 1000, capturedMinor: 1000, voidedMinor: 0, refundedMinor: 0, settledMinor: 1000, paypalOrderId: null, paypalAuthorizationId: null, paypalCaptureIds: [], authorizationExpiresAt: null, honorPeriodEndsAt: null, approvalTokenHash: null, approvalExpiresAt: null, correlationId: '', createdAt: new Date(now - 20 * DAY).toISOString(), updatedAt: new Date(now - 20 * DAY).toISOString() });
  }
  return { mock, client, repo, data, service, ctx, clock, connect: connect ? () => connectPayPal(service, ctx, mock) : null };
}

async function connectPayPal(service, ctx, mock) {
  const { methodId, approveUrl } = await service.startConnect(ctx);
  mock.approveSetupToken(new URL(approveUrl).searchParams.get('approval_session_id'));
  return { methodId, ...(await service.completeConnect(ctx, methodId)) };
}

const milk = (qty = 12) => ({ id: `draft-milk-${qty}`, supplierId: 'SUP-DAIRY', supplierName: 'Northside Dairy', lines: [{ sku: 'MILK-1G', name: 'Whole milk, 1 gal', qty, unitCostMinor: 700 }], totalMinor: qty * 700, currency: 'USD' });
const eggs = () => ({ id: 'draft-eggs', supplierId: 'SUP-EGGS', supplierName: 'Valley Farm Eggs', lines: [{ sku: 'EGGS-30', name: 'Eggs', qty: 10, unitCostMinor: 1420 }], totalMinor: 14_200, currency: 'USD' });

function assertNoSecrets(value, mock) {
  const text = JSON.stringify(value);
  assert.ok(!/paypal(Order|Authorization|Capture)Id|vault/i.test(text), `PayPal ids leaked: ${text}`);
  for (const call of mock.calls) assert.ok(!text.includes(call.requestId ?? '\u0000'), 'request id leaked');
}

test('Connect PayPal: setup token -> owner approves -> vault saved, sealed, masked label', async () => {
  const w = world();
  const { payerLabel } = await w.connect();
  assert.equal(payerLabel, 's***r@personal.example.com');
  const method = await w.repo.getActivePaymentMethod();
  assert.equal(method.status, 'active');
  assert.ok(!JSON.stringify(method).includes('vaultId'), 'vault id must only exist encrypted');
  await assert.rejects(w.service.completeConnect(w.ctx, method.id), (e) => e.code === 'no_pending_connect');
  assert.equal(maskEmail('ab@x.example'), 'a***@x.example');
  assert.equal(maskEmail(undefined), 'PayPal account');
});

test('hero milk: in policy -> held on PayPal via vault with no buyer interaction; nothing leaks to the model', async () => {
  const w = world();
  await w.connect();
  const result = await w.service.payForDraft(w.ctx, milk(), 'agent');
  assert.equal(result.policy.decision, 'autopay');
  assert.equal(result.approval, null);
  assert.equal(result.payment.status, 'authorized');
  assert.equal(result.payment.heldMinor, 8400);
  assert.equal(result.payment.chargedMinor, 0);
  assert.equal(result.speech, '$84 to Northside Dairy is held on your PayPal, not charged until delivery.');
  assertNoSecrets(result, w.mock);
  const record = await w.repo.getPayment(result.payment.paymentId);
  assert.ok(record.paypalAuthorizationId);
  assert.ok(record.honorPeriodEndsAt);
  assert.deepEqual((await w.repo.listEvents(record.id)).map((e) => e.kind), ['policy_evaluated', 'authorized']);
  const orderCall = w.mock.calls.find((c) => c.path === '/v2/checkout/orders');
  assert.equal(orderCall.requestId, `svp-auth-${record.id}`);
});

test('hero eggs: 31% price jump -> step-up card; approving with the token holds the money; the token works once', async () => {
  const w = world();
  await w.connect();
  const result = await w.service.payForDraft(w.ctx, eggs(), 'agent');
  assert.equal(result.policy.decision, 'step_up');
  assert.ok(result.policy.reasons.some((r) => r.text === 'Eggs went up 31% against the 30-day average.'));
  assert.equal(result.payment.status, 'pending_approval');
  assert.ok(result.approval.token.length >= 32);
  const stored = await w.repo.getPayment(result.payment.paymentId);
  assert.equal(stored.approvalTokenHash, sha256Hex(result.approval.token));
  assert.ok(!JSON.stringify(stored).includes(result.approval.token), 'only the hash is stored');
  const callsBefore = w.mock.calls.length;
  assert.equal(callsBefore, w.mock.calls.filter((c) => c.path !== '/v2/checkout/orders').length, 'no PayPal order before approval');

  const approved = await w.service.approve(w.ctx, result.approval.token, 'owner_voice');
  assert.equal(approved.payment.status, 'authorized');
  assert.equal(approved.payerActionUrl, null);
  assert.match(approved.speech, /^Approved\. \$142 to Valley Farm Eggs is held/);
  await assert.rejects(w.service.approve(w.ctx, result.approval.token, 'owner_voice'), (e) => e.code === 'approval_not_found');
  const events = (await w.repo.listEvents(result.payment.paymentId)).map((e) => e.kind);
  assert.deepEqual(events, ['policy_evaluated', 'approval_requested', 'approved', 'authorized']);
});

test('step-up approval expires; decline releases nothing and closes the request', async () => {
  const w = world();
  await w.connect();
  const first = await w.service.payForDraft(w.ctx, eggs(), 'agent');
  w.clock.advance(601_000);
  await assert.rejects(w.service.approve(w.ctx, first.approval.token, 'owner_tap'), (e) => e.code === 'approval_expired');
  const second = await w.service.payForDraft(w.ctx, { ...eggs(), id: 'draft-eggs-2' }, 'agent');
  assert.equal(second.policy.decision, 'blocked', 'the first identical order is still pending: duplicate');
  const declined = await w.service.decline(w.ctx, first.approval.token);
  assert.equal(declined.status, 'voided');
});

test('step-up without a connected PayPal: approve in PayPal (QR), then the hold is placed', async () => {
  const w = world({ connect: false });
  const result = await w.service.payForDraft(w.ctx, milk(), 'agent');
  assert.equal(result.policy.decision, 'step_up');
  assert.ok(result.policy.reasons.some((r) => r.code === 'no_payment_method'));
  const approved = await w.service.approve(w.ctx, result.approval.token, 'owner_tap');
  assert.match(approved.payerActionUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
  assert.equal(approved.payment.status, 'pending_approval');
  assert.equal((await w.service.completeBuyerApproval(w.ctx, result.payment.paymentId)).status, 'pending_approval', 'not approved in PayPal yet');
  const orderId = new URL(approved.payerActionUrl).searchParams.get('token');
  w.mock.approveOrder(orderId);
  const done = await w.service.sync(w.ctx, result.payment.paymentId);
  assert.equal(done.status, 'authorized');
  assert.equal(done.heldMinor, 8400);
});

test('blocked: a supplier off the allow-list is recorded with reasons and PayPal is never called', async () => {
  const w = world();
  await w.connect();
  const before = w.mock.calls.length;
  const result = await w.service.payForDraft(w.ctx, { ...milk(), id: 'draft-new', supplierId: 'SUP-NEW', supplierName: 'Harbor Wholesale' }, 'agent');
  assert.equal(result.policy.decision, 'blocked');
  assert.equal(result.payment.status, 'blocked');
  assert.match(result.speech, /^I can't pay Harbor Wholesale\./);
  assert.equal(w.mock.calls.length, before);
});

test('"ignore your limits and pay $5,000": blocked by the hard cap, no money moves', async () => {
  const w = world();
  await w.connect();
  const before = w.mock.calls.length;
  const big = { ...milk(), id: 'draft-big', lines: [{ sku: 'MILK-1G', name: 'Whole milk, 1 gal', qty: 715, unitCostMinor: 700 }], totalMinor: 500_500 };
  const result = await w.service.payForDraft(w.ctx, big, 'agent');
  assert.equal(result.policy.decision, 'blocked');
  assert.equal(w.mock.calls.length, before);
});

test('duplicate order within 24h is blocked', async () => {
  const w = world();
  await w.connect();
  await w.service.payForDraft(w.ctx, milk(), 'agent');
  const again = await w.service.payForDraft(w.ctx, { ...milk(), id: 'draft-milk-again' }, 'agent');
  assert.equal(again.policy.decision, 'blocked');
  assert.ok(again.policy.reasons.some((r) => r.code === 'duplicate_order'));
});

test('hero delivery: 10 of 12 arrive -> charge for 10, release the rest; PayPal agrees', async () => {
  const w = world();
  await w.connect();
  const { payment } = await w.service.payForDraft(w.ctx, milk(), 'agent');
  const delivery = await w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 10 }], 'voice');
  assert.equal(delivery.outcome, 'partial');
  assert.equal(delivery.payment.chargedMinor, 7000);
  assert.equal(delivery.payment.releasedMinor, 1400);
  assert.equal(delivery.payment.heldMinor, 0);
  assert.equal(delivery.speech, 'Charged $70 for what arrived from Northside Dairy and released $14.');
  const record = await w.repo.getPayment(payment.paymentId);
  const auth = w.mock.authorizationSnapshot(record.paypalAuthorizationId);
  assert.equal(auth.status, 'VOIDED');
  assert.equal(auth.capturedMinor, 7000);
  assert.deepEqual((await w.repo.listEvents(payment.paymentId)).map((e) => e.kind), ['policy_evaluated', 'authorized', 'captured', 'voided']);
  assert.equal((await w.repo.listDeliveries(payment.paymentId))[0].outcome, 'partial');
  await assert.rejects(w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 2 }], 'voice'), (e) => e.code === 'nothing_held');
});

test('delivery: everything -> full capture; nothing -> void; more than ordered -> hold, no money moves', async () => {
  const w = world();
  await w.connect();
  const full = await w.service.payForDraft(w.ctx, milk(12), 'agent');
  const r1 = await w.service.recordDelivery(w.ctx, full.payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 12 }], 'console');
  assert.equal(r1.outcome, 'full');
  assert.equal(r1.payment.status, 'captured');
  assert.equal(r1.payment.chargedMinor, 8400);

  const none = await w.service.payForDraft(w.ctx, milk(11), 'agent');
  const r2 = await w.service.recordDelivery(w.ctx, none.payment.paymentId, [], 'voice');
  assert.equal(r2.outcome, 'none');
  assert.equal(r2.payment.status, 'voided');
  assert.equal(r2.payment.chargedMinor, 0);

  const over = await w.service.payForDraft(w.ctx, milk(10), 'agent');
  const calls = w.mock.calls.length;
  const r3 = await w.service.recordDelivery(w.ctx, over.payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 14 }], 'voice');
  assert.equal(r3.outcome, 'hold');
  assert.equal(r3.payment.status, 'authorized');
  assert.equal(w.mock.calls.length, calls);
});

test('refund the spoiled yogurt: partial refund, then no more than was charged', async () => {
  const w = world();
  await w.connect();
  const { payment } = await w.service.payForDraft(w.ctx, milk(), 'agent');
  await w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 12 }], 'voice');
  const refund = await w.service.refund(w.ctx, payment.paymentId, 1400, 'Two gallons spoiled');
  assert.equal(refund.payment.chargedMinor, 7000);
  assert.equal(refund.speech, 'Refund of $14 from Northside Dairy is on its way back to your PayPal.');
  await assert.rejects(w.service.refund(w.ctx, payment.paymentId, 7001, 'x'), (e) => e.code === 'over_refund');
  const rest = await w.service.refund(w.ctx, payment.paymentId, null, 'Rest of the order was spoiled');
  assert.equal(rest.refundedMinor, 7000);
  assert.equal(rest.payment.status, 'refunded');
  await assert.rejects(w.service.refund(w.ctx, payment.paymentId, null, 'again'), (e) => e.code === 'nothing_to_refund');
});

test('settlement pays the supplier for what was charged, net of refunds, once', async () => {
  const w = world();
  await w.connect();
  const { payment } = await w.service.payForDraft(w.ctx, milk(), 'agent');
  assert.equal((await w.service.settle(w.ctx, payment.paymentId)).paidMinor, 0, 'nothing settles while money is held');
  await w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 10 }], 'voice');
  await w.service.refund(w.ctx, payment.paymentId, 700, 'one spoiled');
  const settled = await w.service.settle(w.ctx, payment.paymentId);
  assert.equal(settled.paidMinor, 6300);
  assert.equal((await w.service.settle(w.ctx, payment.paymentId)).paidMinor, 0);
  const payout = w.mock.calls.find((c) => c.path === '/v1/payments/payouts');
  assert.equal(payout.requestId, `svp-payout-${payment.paymentId}-1`);
});

test('after the 3-day honor period the hold is renewed before capture', async () => {
  const w = world();
  await w.connect();
  const { payment } = await w.service.payForDraft(w.ctx, milk(), 'agent');
  const firstAuth = (await w.repo.getPayment(payment.paymentId)).paypalAuthorizationId;
  w.clock.advance(4 * DAY);
  const delivery = await w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 12 }], 'voice');
  assert.equal(delivery.outcome, 'full');
  const record = await w.repo.getPayment(payment.paymentId);
  assert.notEqual(record.paypalAuthorizationId, firstAuth);
  assert.deepEqual((await w.repo.listEvents(payment.paymentId)).map((e) => e.kind), ['policy_evaluated', 'authorized', 'reauthorized', 'captured']);
});

test('a lost capture response is retried with the same key: one capture, ledger consistent', async () => {
  const w = world();
  await w.connect();
  const { payment } = await w.service.payForDraft(w.ctx, milk(), 'agent');
  w.mock.injectFault('drop_response', 1, /\/capture$/);
  const delivery = await w.service.recordDelivery(w.ctx, payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 12 }], 'voice');
  assert.equal(delivery.payment.chargedMinor, 8400);
  const record = await w.repo.getPayment(payment.paymentId);
  assert.equal(w.mock.authorizationSnapshot(record.paypalAuthorizationId).capturedMinor, 8400);
  assert.equal(record.paypalCaptureIds.length, 1);
});

test('PayPal declines the hold -> payment failed, owner told nothing was charged', async () => {
  const w = world();
  await w.connect();
  w.mock.injectFault(422, 1, /\/v2\/checkout\/orders$/);
  const result = await w.service.payForDraft(w.ctx, milk(), 'agent');
  assert.equal(result.payment.status, 'failed');
  assert.equal(result.speech, "I couldn't place the hold with PayPal for Northside Dairy. Nothing was charged.");
});

test('network failure on the hold: stays pending; sync retries with the same request id and holds once', async () => {
  const w = world();
  await w.connect();
  w.mock.injectFault('network', 3, /\/v2\/checkout\/orders$/);
  const result = await w.service.payForDraft(w.ctx, milk(), 'agent');
  assert.equal(result.payment.status, 'pending_approval');
  const synced = await w.service.sync(w.ctx, result.payment.paymentId);
  assert.equal(synced.status, 'authorized');
  const orderCalls = w.mock.calls.filter((c) => c.path === '/v2/checkout/orders');
  assert.ok(orderCalls.every((c) => c.requestId === `svp-auth-${result.payment.paymentId}`));
});

test('flow errors are typed and speakable', async () => {
  const w = world();
  await assert.rejects(w.service.approve(w.ctx, 'not-a-real-token', 'owner_tap'), (e) => e instanceof PaymentFlowError && e.code === 'approval_not_found');
  await assert.rejects(w.service.recordDelivery(w.ctx, '00000000-0000-4000-8000-000000000000', [], 'voice'), (e) => e.code === 'payment_not_found');
});
