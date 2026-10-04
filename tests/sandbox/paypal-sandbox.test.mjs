// Real PayPal sandbox checks. Skipped unless PAYPAL_CLIENT_ID/SECRET are set
// (CI sets them from repository secrets). Steps that need the sandbox buyer
// to click "Approve" are covered by `npm run spike`; here we use a vault id
// saved by the spike (SANDBOX_VAULT_ID) so the money flow runs unattended.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPayPalRuntime, newRequestId, findLink, createOrder, firstAuthorization, captureAuthorization,
  voidAuthorization, getAuthorization, refundCapture, createSetupToken, verifyWebhookSignature
} from '../../apps/mcp-server/dist/payments/index.js';

const enabled = !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
const vaultId = process.env.SANDBOX_VAULT_ID ?? '';
const payee = process.env.SANDBOX_SUPPLIER_EMAIL ?? '';
const runtime = enabled ? createPayPalRuntime({ ...process.env, PAYPAL_MODE: 'sandbox' }) : null;
const USD = (amountMinor) => ({ amountMinor, currency: 'USD' });

test('sandbox: OAuth client-credentials token', { skip: !enabled }, async () => {
  const token = await runtime.client.accessToken();
  assert.ok(token.length > 20);
});

test('sandbox: AUTHORIZE order asks the buyer to approve via payer-action', { skip: !enabled }, async () => {
  const order = await createOrder(runtime.client, {
    intent: 'AUTHORIZE',
    purchaseUnit: { referenceId: 'sandbox-test', description: 'ShopVoice Pay sandbox test', amount: USD(1500), ...(payee ? { payee: { emailAddress: payee } } : {}) },
    paymentSource: { kind: 'paypal_approval', returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', brandName: 'ShopVoice Pay (sandbox)' },
    requestId: newRequestId('sbx-order')
  });
  assert.equal(order.status, 'PAYER_ACTION_REQUIRED');
  assert.match(findLink(order.links, 'payer-action'), /sandbox\.paypal\.com/);
});

test('sandbox: vault setup token needs payer approval', { skip: !enabled }, async () => {
  const setup = await createSetupToken(runtime.client, { returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', brandName: 'ShopVoice Pay (sandbox)', description: 'ShopVoice Pay test', requestId: newRequestId('sbx-setup') });
  assert.equal(setup.status, 'PAYER_ACTION_REQUIRED');
  assert.ok(findLink(setup.links, 'approve'));
});

test('sandbox: forged webhook delivery fails verification', { skip: !enabled }, async () => {
  const ok = await verifyWebhookSignature(runtime.client, {
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '0SANDBOXFORGED0000', // PayPal requires ^[a-zA-Z0-9]+$
    headers: { authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77', transmissionId: '00000000-0000-0000-0000-000000000000', transmissionSig: 'Zm9yZ2Vk', transmissionTime: new Date().toISOString() },
    rawEvent: JSON.stringify({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
    requestId: newRequestId('sbx-whv')
  });
  // A schema error would also be "not verified"; insist on PayPal's real verdict.
  assert.equal(ok, false);
});

test('sandbox: vaulted authorize -> partial capture -> void remainder -> refund', { skip: !enabled || !vaultId }, async () => {
  const order = await createOrder(runtime.client, {
    intent: 'AUTHORIZE',
    purchaseUnit: { referenceId: 'sandbox-partial', description: 'ShopVoice Pay partial delivery test', amount: USD(12000) },
    paymentSource: { kind: 'vault', vaultId },
    requestId: newRequestId('sbx-vorder')
  });
  const auth = firstAuthorization(order);
  assert.equal(auth.status, 'CREATED');
  const capture = await captureAuthorization(runtime.client, auth.id, { amount: USD(10000), finalCapture: false, requestId: newRequestId('sbx-cap') });
  assert.equal(capture.status, 'COMPLETED');
  await voidAuthorization(runtime.client, auth.id, newRequestId('sbx-void'));
  assert.equal((await getAuthorization(runtime.client, auth.id)).status, 'VOIDED');
  const refund = await refundCapture(runtime.client, capture.id, { amount: USD(1200), requestId: newRequestId('sbx-refund') });
  assert.equal(refund.status, 'COMPLETED');
});
