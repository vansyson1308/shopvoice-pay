// PayPal Agent Toolkit behind ShopVoice's policy layer, against the real
// PayPal sandbox: tracking added to a real capture after delivery, the ledger
// cross-checked with transaction search (which lags in the sandbox), and a
// catering invoice created and sent to the supplier's sandbox account.
// Needs SANDBOX_VAULT_ID and SANDBOX_SUPPLIER_EMAIL; skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload } from '../../packages/common/dist/index.js';
import { createPayPalRuntime, PaymentsService } from '../../apps/mcp-server/dist/payments/index.js';
import { MemoryPaymentsData, MemoryPaymentsRepository } from '../../apps/mcp-server/dist/ledger/index.js';
import { DEFAULT_POLICY } from '../../apps/mcp-server/dist/policy/index.js';
import { createToolkitRunner } from '../../apps/mcp-server/dist/toolkit/agent-toolkit.js';
import { ToolkitGateway, loadToolkitGatewayConfig, recipientAllowed } from '../../apps/mcp-server/dist/toolkit/toolkit-gateway.js';

const vaultId = process.env.SANDBOX_VAULT_ID ?? '';
const supplierEmail = process.env.SANDBOX_SUPPLIER_EMAIL ?? '';
const enabled = !!process.env.PAYPAL_CLIENT_ID && !!vaultId && !!supplierEmail;
const MEK = Buffer.alloc(32, 5).toString('base64');

test('sandbox: Agent Toolkit tracking, records cross-check and catering invoice', { skip: !enabled }, async () => {
  const runtime = createPayPalRuntime({ ...process.env, PAYPAL_MODE: 'sandbox' });
  const gateway = new ToolkitGateway(createToolkitRunner(runtime), loadToolkitGatewayConfig({}));
  const data = new MemoryPaymentsData({
    policy: { ...DEFAULT_POLICY, allowListedSupplierIds: ['SUP-BAKERY'] },
    payees: [{ supplierCode: 'SUP-BAKERY', paypalEmail: supplierEmail, paypalMerchantId: null, currency: 'USD', verified: true }],
    pastQuantities: { 'BREAD-WHITE': [10, 10] }
  });
  const repo = new MemoryPaymentsRepository(data, Date.now);
  const method = await repo.createPaymentMethod(encryptPayload(JSON.stringify({ vaultId }), MEK), 's***x@personal.example.com');
  await repo.updatePaymentMethod(method.id, 'active', null, null);
  data.payments.set('past', { id: 'past', draftId: null, supplierCode: 'SUP-BAKERY', currency: 'USD', status: 'captured', decision: 'autopay', decisionReasons: [], linesFingerprint: 'past', lines: [], createdBy: 'agent', approvedBy: null, requestedMinor: 100, authorizedMinor: 100, capturedMinor: 100, voidedMinor: 0, refundedMinor: 0, settledMinor: 100, paypalOrderId: null, paypalAuthorizationId: null, paypalCaptureIds: [], authorizationExpiresAt: null, honorPeriodEndsAt: null, approvalTokenHash: null, approvalExpiresAt: null, correlationId: '', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), updatedAt: new Date().toISOString() });

  const service = new PaymentsService(runtime.client, { brandName: 'ShopVoice Pay (sandbox)', returnBaseUrl: 'https://example.com', mekB64: MEK, approvalTtlSeconds: 600, timeZone: 'America/New_York' });
  service.useToolkit(gateway);
  const ctx = { repo, correlationId: `sbx-tk-${Date.now()}`, supplierName: () => 'Hillside Bakery' };
  const draft = { id: `draft-sbx-tk-${Date.now()}`, supplierId: 'SUP-BAKERY', supplierName: 'Hillside Bakery', lines: [{ sku: 'BREAD-WHITE', name: 'White sandwich bread 20 oz', qty: 10, unitCostMinor: 300 }], totalMinor: 3000, currency: 'USD' };

  const paid = await service.payForDraft(ctx, draft, 'agent');
  assert.equal(paid.payment.status, 'authorized', paid.speech);
  const delivered = await service.recordDelivery(ctx, paid.payment.paymentId, [{ sku: 'BREAD-WHITE', receivedQty: 10 }], 'voice');
  assert.equal(delivered.outcome, 'full');
  const kinds = (await repo.listEvents(paid.payment.paymentId)).map((e) => e.kind);
  assert.deepEqual(kinds, ['policy_evaluated', 'authorized', 'captured', 'shipment_tracked']);

  const record = await repo.getPayment(paid.payment.paymentId);
  const tracking = await gateway.tracking(ctx, record);
  assert.equal(tracking.status, 'tracked');
  assert.ok(tracking.trackers.some((t) => t.status === 'DELIVERED'));

  // Transaction search lags in the sandbox (toolkit spike T7): lag is fine, a wrong amount is not.
  const check = await gateway.crossCheck(ctx, 7);
  assert.ok(['match', 'lagging'].includes(check.status), JSON.stringify(check));
  assert.equal(check.amountMismatches, 0);

  if (recipientAllowed(supplierEmail.toLowerCase(), gateway.config.recipientDomains)) {
    const invoice = await gateway.prepareCatering(ctx, { customerEmail: supplierEmail, customerName: 'Sandbox catering customer', items: [{ name: 'Sandwich platter, serves 10', qty: 1, unitPriceMinor: 4500 }], note: 'Sandbox test invoice', currency: 'USD', createdBy: 'agent' });
    const sent = await gateway.sendCatering(ctx, invoice.id, "Maria's Corner Market");
    assert.equal(sent.status, 'sent');
    assert.match(sent.paypalInvoiceId, /^INV2-/);
    const listed = await gateway.listCatering(ctx, 1);
    assert.ok(['sent', 'paid'].includes(listed[0].status));
  }
});
