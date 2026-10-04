// The hero money path through PaymentsService against the real PayPal
// sandbox: vaulted hold -> 10 of 12 delivered (capture + release) -> refund
// -> supplier payout. Needs SANDBOX_VAULT_ID (saved by `npm run spike`) and
// SANDBOX_SUPPLIER_EMAIL; skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload } from '../../packages/common/dist/index.js';
import { createPayPalRuntime, PaymentsService, getAuthorization } from '../../apps/mcp-server/dist/payments/index.js';
import { MemoryPaymentsData, MemoryPaymentsRepository } from '../../apps/mcp-server/dist/ledger/index.js';
import { DEFAULT_POLICY } from '../../apps/mcp-server/dist/policy/index.js';

const vaultId = process.env.SANDBOX_VAULT_ID ?? '';
const supplierEmail = process.env.SANDBOX_SUPPLIER_EMAIL ?? '';
const enabled = !!process.env.PAYPAL_CLIENT_ID && !!vaultId && !!supplierEmail;
const MEK = Buffer.alloc(32, 3).toString('base64');

test('sandbox: hero money path through PaymentsService', { skip: !enabled }, async () => {
  const { client } = createPayPalRuntime({ ...process.env, PAYPAL_MODE: 'sandbox' });
  const data = new MemoryPaymentsData({
    policy: { ...DEFAULT_POLICY, allowListedSupplierIds: ['SUP-DAIRY'] },
    payees: [{ supplierCode: 'SUP-DAIRY', paypalEmail: supplierEmail, paypalMerchantId: null, currency: 'USD', verified: true }],
    pastQuantities: { 'MILK-1G': [12, 12] }
  });
  const repo = new MemoryPaymentsRepository(data, Date.now);
  const method = await repo.createPaymentMethod(encryptPayload(JSON.stringify({ vaultId }), MEK), 's***x@personal.example.com');
  await repo.updatePaymentMethod(method.id, 'active', null, null);
  // A past completed order, so this is not a "first order" step-up.
  data.payments.set('past', { id: 'past', draftId: null, supplierCode: 'SUP-DAIRY', currency: 'USD', status: 'captured', decision: 'autopay', decisionReasons: [], linesFingerprint: 'past', lines: [], createdBy: 'agent', approvedBy: null, requestedMinor: 100, authorizedMinor: 100, capturedMinor: 100, voidedMinor: 0, refundedMinor: 0, settledMinor: 100, paypalOrderId: null, paypalAuthorizationId: null, paypalCaptureIds: [], authorizationExpiresAt: null, honorPeriodEndsAt: null, approvalTokenHash: null, approvalExpiresAt: null, correlationId: '', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), updatedAt: new Date().toISOString() });

  const service = new PaymentsService(client, { brandName: 'ShopVoice Pay (sandbox)', returnBaseUrl: 'https://example.com', mekB64: MEK, approvalTtlSeconds: 600, timeZone: 'America/New_York' });
  const ctx = { repo, correlationId: `sbx-${Date.now()}`, supplierName: () => 'Northside Dairy' };
  const draft = { id: `draft-sbx-${Date.now()}`, supplierId: 'SUP-DAIRY', supplierName: 'Northside Dairy', lines: [{ sku: 'MILK-1G', name: 'Whole milk, 1 gal', qty: 12, unitCostMinor: 700 }], totalMinor: 8400, currency: 'USD' };

  const paid = await service.payForDraft(ctx, draft, 'agent');
  assert.equal(paid.policy.decision, 'autopay');
  assert.equal(paid.payment.status, 'authorized');
  const delivery = await service.recordDelivery(ctx, paid.payment.paymentId, [{ sku: 'MILK-1G', receivedQty: 10 }], 'voice');
  assert.equal(delivery.outcome, 'partial');
  assert.equal(delivery.payment.chargedMinor, 7000);
  const record = await repo.getPayment(paid.payment.paymentId);
  assert.equal((await getAuthorization(client, record.paypalAuthorizationId)).status, 'VOIDED');
  const refund = await service.refund(ctx, paid.payment.paymentId, 700, 'One gallon spoiled (sandbox test)');
  assert.equal(refund.payment.chargedMinor, 6300);
  const settled = await service.settle(ctx, paid.payment.paymentId);
  assert.equal(settled.paidMinor, 6300);
  assert.deepEqual((await repo.listEvents(paid.payment.paymentId)).map((e) => e.kind), ['policy_evaluated', 'authorized', 'captured', 'voided', 'refunded', 'payout_sent']);
});
