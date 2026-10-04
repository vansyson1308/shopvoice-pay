#!/usr/bin/env node
// Day-1 PayPal sandbox spike (docs/paypal/SPIKE.md §4). Runs every check the
// payment architecture depends on and writes the evidence to
// docs/paypal/spike-results.<mode>.json.
//
//   PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   SPIKE_SUPPLIER_EMAIL=<sandbox business account email> npm run spike
//
// Steps that need the sandbox buyer print a PayPal URL; open it, log in as the
// sandbox personal account, approve, and the script continues on its own
// (it polls the order / setup token). PAYPAL_MODE=mock runs the same steps
// against the in-process fake, approving automatically: a self-test of this
// script, not evidence about PayPal.
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPayPalRuntime, newRequestId, PayPalApiError, findLink,
  createOrder, getOrder, authorizeOrder, firstAuthorization, firstCapture, captureAuthorization,
  voidAuthorization, reauthorize, getAuthorization, refundCapture, createSetupToken, getSetupToken,
  createPaymentToken, createPayout, getPayoutBatch, verifyWebhookSignature, listWebhooks, registerWebhook
} from '../../apps/mcp-server/dist/payments/index.js';

const env = process.env;
const runtime = createPayPalRuntime(env);
const { client, mock } = runtime;
const mode = runtime.config.mode;
const supplierEmail = env.SPIKE_SUPPLIER_EMAIL || 'northside-dairy@business.example.com';
const returnUrl = env.SPIKE_RETURN_URL || 'https://example.com/shopvoice/return';
const cancelUrl = env.SPIKE_CANCEL_URL || 'https://example.com/shopvoice/cancel';
const approvalTimeoutMs = Number(env.SPIKE_APPROVAL_TIMEOUT_MS || 10 * 60_000);
const only = new Set((env.SPIKE_ONLY || '').split(',').filter(Boolean));

const USD = (amountMinor) => ({ amountMinor, currency: 'USD' });
const results = [];

/** Short, non-reversible handle for ids in committed evidence. */
function tag(value) {
  return typeof value === 'string' && value.length > 6 ? `${value.slice(0, 4)}…${value.slice(-2)}` : value;
}

function errorEvidence(error) {
  if (error instanceof PayPalApiError) {
    return { http_status: error.status, name: error.name, issue: error.code, debug_id: error.debugId, issues: error.issues.map((i) => i.issue) };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

async function check(id, title, fn) {
  if (only.size && !only.has(id.split('.')[0])) return undefined;
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    const { status = 'pass', evidence = {}, value } = (await fn()) ?? {};
    results.push({ id, title, status, ms: Date.now() - started, evidence });
    console.log(`  -> ${status.toUpperCase()} ${JSON.stringify(evidence)}`);
    return value;
  } catch (error) {
    const evidence = errorEvidence(error);
    results.push({ id, title, status: 'fail', ms: Date.now() - started, evidence });
    console.log(`  -> FAIL ${JSON.stringify(evidence)}`);
    return undefined;
  }
}

/** Expected-error probe: passes when PayPal answers with an API error and records which one. */
async function probe(fn) {
  try {
    const value = await fn();
    return { outcome: 'accepted', value };
  } catch (error) {
    if (error instanceof PayPalApiError) return { outcome: 'rejected', ...errorEvidence(error) };
    throw error;
  }
}

async function waitForBuyer(kind, id, url, isApproved) {
  if (mock) {
    if (kind === 'order') mock.approveOrder(id);
    else mock.approveSetupToken(id);
    return;
  }
  console.log(`  Buyer approval needed (${kind}). Open this URL, log in as the sandbox PERSONAL account and approve:\n    ${url}`);
  const deadline = Date.now() + approvalTimeoutMs;
  while (Date.now() < deadline) {
    if (await isApproved()) return;
    await sleep(3000);
  }
  throw new Error(`buyer_approval_timeout:${kind}`);
}

async function buyerApprovedAuthorization(amountMinor, payee, label) {
  const order = await createOrder(client, {
    intent: 'AUTHORIZE',
    purchaseUnit: {
      referenceId: label,
      description: `ShopVoice Pay spike: ${label}`,
      invoiceId: newRequestId('SPIKE-INV').slice(0, 40),
      customId: label,
      amount: USD(amountMinor),
      items: [{ name: 'Whole milk, 1 gal', sku: 'MILK-1G', quantity: amountMinor / 700, unitAmount: USD(700) }],
      ...(payee ? { payee: { emailAddress: payee } } : {})
    },
    paymentSource: { kind: 'paypal_approval', returnUrl, cancelUrl, brandName: 'ShopVoice Pay (sandbox)' },
    requestId: newRequestId('spike-order')
  });
  const url = findLink(order.links, 'payer-action', 'approve');
  await waitForBuyer('order', order.id, url, async () => (await getOrder(client, order.id)).status === 'APPROVED');
  const authorized = await authorizeOrder(client, order.id, newRequestId('spike-authorize'));
  return { order, authorization: firstAuthorization(authorized) };
}

async function vaultedOrder(intent, vaultId, amountMinor, payee, label) {
  return createOrder(client, {
    intent,
    purchaseUnit: {
      referenceId: label,
      description: `ShopVoice Pay spike: ${label}`,
      customId: label,
      amount: USD(amountMinor),
      ...(payee ? { payee: { emailAddress: payee } } : {})
    },
    paymentSource: { kind: 'vault', vaultId },
    requestId: newRequestId('spike-vault-order')
  });
}

console.log(`ShopVoice Pay spike: mode=${mode} base=${client.baseUrl} supplier=${supplierEmail}`);
if (mode === 'mock') console.log('NOTE: mock mode is a self-test of this script. It is not evidence about PayPal.');

// §4.1 OAuth
await check('S1', 'OAuth client-credentials token', async () => {
  const res = await client.request({ method: 'GET', path: '/v1/notifications/webhooks-event-types' }).catch((e) => e);
  await client.accessToken();
  return { evidence: { token: 'obtained', event_types_endpoint: res instanceof Error ? errorEvidence(res) : 'ok' } };
});

// §4.2 Orders v2 AUTHORIZE, buyer-approved, third-party payee
const directAuth = await check('S2.1', 'Buyer-approved AUTHORIZE order with supplier as payee', async () => {
  const { order, authorization } = await buyerApprovedAuthorization(12_600, supplierEmail, 'direct-payee');
  return {
    evidence: { order: tag(order.id), created_status: order.status, link_rel: order.links?.map((l) => l.rel), authorization_status: authorization?.status, create_time: authorization?.create_time, expiration_time: authorization?.expiration_time },
    value: authorization
  };
});

if (directAuth) {
  await check('S2.2', 'Partial capture (final_capture:false) then void the remainder', async () => {
    const capture = await captureAuthorization(client, directAuth.id, { amount: USD(8_400), finalCapture: false, invoiceId: newRequestId('SPIKE-CAP').slice(0, 40), requestId: newRequestId('spike-capture') });
    const afterCapture = await getAuthorization(client, directAuth.id);
    const voided = await probe(() => voidAuthorization(client, directAuth.id, newRequestId('spike-void')));
    const afterVoid = await getAuthorization(client, directAuth.id);
    return { evidence: { capture: tag(capture.id), capture_status: capture.status, captured: capture.amount, auth_after_capture: afterCapture.status, void: voided.outcome, void_error: voided.issue, auth_after_void: afterVoid.status } , value: capture };
  });
  await check('S2.3', 'Reauthorize inside the 3-day honor period (expected rejection)', async () => {
    const result = await probe(() => reauthorize(client, directAuth.id, null, newRequestId('spike-reauth')));
    return { status: result.outcome === 'rejected' ? 'pass' : 'info', evidence: result.outcome === 'rejected' ? { rejected_with: result.issue } : { accepted: true } };
  });
}

// §4.3 Vault v3 save-without-purchase
const vaultId = await check('S3.1', 'Vault setup token -> buyer approval -> payment token (vault id)', async () => {
  const setup = await createSetupToken(client, { returnUrl, cancelUrl, brandName: 'ShopVoice Pay (sandbox)', description: 'ShopVoice Pay supplier payments', requestId: newRequestId('spike-setup') });
  const url = findLink(setup.links, 'approve');
  await waitForBuyer('setup_token', setup.id, url, async () => ['APPROVED', 'VAULTED'].includes((await getSetupToken(client, setup.id)).status));
  const token = await createPaymentToken(client, setup.id, newRequestId('spike-ptoken'));
  return { evidence: { setup_status: setup.status, approve_link: url ? new URL(url).pathname : null, vault_id: tag(token.id), customer: tag(token.customer?.id), payer_email_present: !!token.payment_source?.paypal?.email_address }, value: token.id };
});

const vaultMatrix = {};
if (vaultId) {
  for (const [intent, payee, label] of [['CAPTURE', supplierEmail, 'vault-capture-payee'], ['AUTHORIZE', supplierEmail, 'vault-authorize-payee'], ['CAPTURE', null, 'vault-capture-platform'], ['AUTHORIZE', null, 'vault-authorize-platform']]) {
    await check(`S3.${label}`, `Vaulted ${intent} order, payee=${payee ? 'supplier (third party)' : 'platform (API caller)'}`, async () => {
      const result = await probe(() => vaultedOrder(intent, vaultId, 8_400, payee, label));
      vaultMatrix[label] = result;
      const order = result.value;
      return {
        status: 'info',
        evidence: result.outcome === 'accepted'
          ? { accepted: true, order_status: order.status, authorization: firstAuthorization(order)?.status ?? null, capture: firstCapture(order)?.status ?? null }
          : { accepted: false, http_status: result.http_status, issue: result.issue, debug_id: result.debug_id }
      };
    });
  }
}

// Remaining §4.2 outcomes on vaulted platform authorizations (no buyer interaction needed)
async function platformAuthorization(label) {
  const order = await vaultedOrder('AUTHORIZE', vaultId, 8_400, vaultMatrix['vault-authorize-payee']?.outcome === 'accepted' ? supplierEmail : null, label);
  return firstAuthorization(order);
}

let fullCapture;
if (vaultId) {
  fullCapture = await check('S2.4', 'Full capture of an authorization', async () => {
    const auth = await platformAuthorization('full-capture');
    const capture = await captureAuthorization(client, auth.id, { finalCapture: true, requestId: newRequestId('spike-capture') });
    return { evidence: { capture_status: capture.status, amount: capture.amount, auth_after: (await getAuthorization(client, auth.id)).status }, value: capture };
  });
  await check('S2.5', 'Partial capture with final_capture:true, then void the remainder', async () => {
    const auth = await platformAuthorization('final-partial');
    const capture = await captureAuthorization(client, auth.id, { amount: USD(7_000), finalCapture: true, requestId: newRequestId('spike-capture') });
    const afterCapture = await getAuthorization(client, auth.id);
    const voided = await probe(() => voidAuthorization(client, auth.id, newRequestId('spike-void')));
    return { evidence: { capture_status: capture.status, captured: capture.amount, auth_after_capture: afterCapture.status, void: voided.outcome, void_error: voided.issue ?? null, auth_after_void: (await getAuthorization(client, auth.id)).status } };
  });
  await check('S2.6', 'Void an untouched authorization', async () => {
    const auth = await platformAuthorization('void');
    await voidAuthorization(client, auth.id, newRequestId('spike-void'));
    const after = await getAuthorization(client, auth.id);
    const capture = await probe(() => captureAuthorization(client, auth.id, { finalCapture: true, requestId: newRequestId('spike-capture') }));
    return { evidence: { auth_after_void: after.status, capture_after_void: capture.outcome, error: capture.issue ?? null } };
  });
  await check('S2.7', 'Idempotency: same PayPal-Request-Id twice moves money once', async () => {
    const auth = await platformAuthorization('idempotency');
    const key = newRequestId('spike-capture-idem');
    const first = await captureAuthorization(client, auth.id, { amount: USD(1_000), finalCapture: false, requestId: key });
    const second = await captureAuthorization(client, auth.id, { amount: USD(1_000), finalCapture: false, requestId: key });
    const after = await getAuthorization(client, auth.id);
    await probe(() => voidAuthorization(client, auth.id, newRequestId('spike-void')));
    return { status: first.id === second.id ? 'pass' : 'fail', evidence: { same_capture_id: first.id === second.id, auth_after: after.status } };
  });
}

// §4.4 Refunds
if (fullCapture) {
  await check('S4', 'Refund a capture: partial, then the rest', async () => {
    const partial = await refundCapture(client, fullCapture.id, { amount: USD(1_200), noteToPayer: 'Spoiled yogurt (spike)', requestId: newRequestId('spike-refund') });
    const rest = await refundCapture(client, fullCapture.id, { requestId: newRequestId('spike-refund') });
    const again = await probe(() => refundCapture(client, fullCapture.id, { requestId: newRequestId('spike-refund') }));
    return { evidence: { partial: { status: partial.status, amount: partial.amount }, rest: { status: rest.status, amount: rest.amount }, third_refund: again.outcome, error: again.issue ?? null } };
  });
}

// Fallback settlement: Payouts from the platform account to the supplier
await check('S5', 'Payouts: platform account -> supplier sandbox business account', async () => {
  const batch = await createPayout(client, {
    senderBatchId: newRequestId('spike-batch').slice(0, 30),
    emailSubject: 'Payment from ShopVoice Pay (sandbox)',
    items: [{ receiverEmail: supplierEmail, amount: USD(8_400), note: 'Spike settlement for PO-SPIKE', senderItemId: 'spike-item-1' }],
    requestId: newRequestId('spike-payout')
  });
  await sleep(mock ? 0 : 5000);
  const status = await getPayoutBatch(client, batch.batch_header.payout_batch_id);
  return { evidence: { created: batch.batch_header.batch_status, after_5s: status.batch_header.batch_status, item_status: status.items?.[0]?.transaction_status ?? null } };
});

// §4.6 Webhooks
await check('S6.1', 'Webhook registration for the six event types', async () => {
  if (!env.SPIKE_WEBHOOK_URL) {
    const hooks = mock ? [] : await listWebhooks(client);
    return { status: 'skipped', evidence: { reason: 'SPIKE_WEBHOOK_URL not set (needs a public https URL)', existing_webhooks: hooks.length } };
  }
  const hook = await registerWebhook(client, env.SPIKE_WEBHOOK_URL, newRequestId('spike-webhook'));
  return { evidence: { webhook_id: tag(hook.id), events: hook.event_types.map((e) => e.name) } };
});

await check('S6.2', 'verify-webhook-signature rejects a forged delivery', async () => {
  const rawEvent = JSON.stringify({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X', amount: { currency_code: 'USD', value: '5000.00' } } });
  const ok = await verifyWebhookSignature(client, {
    webhookId: env.PAYPAL_WEBHOOK_ID || 'WH-SPIKE-FORGED',
    headers: { authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77', transmissionId: '00000000-0000-0000-0000-000000000000', transmissionSig: 'Zm9yZ2Vk', transmissionTime: new Date().toISOString() },
    rawEvent,
    requestId: newRequestId('spike-whverify')
  });
  return { status: ok ? 'fail' : 'pass', evidence: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
});

const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
const report = { mode, base_url: client.baseUrl, ran_at: new Date().toISOString(), supplier_email_domain: supplierEmail.split('@')[1], summary, results };
mkdirSync('docs/paypal', { recursive: true });
const out = `docs/paypal/spike-results.${mode}.json`;
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nSummary: ${JSON.stringify(summary)}  ->  ${out}`);
if (mock) {
  console.log(`mock calls: ${mock.calls.length}, all POSTs idempotent: ${mock.calls.filter((c) => c.method === 'POST').every((c) => c.requestId)}`);
}
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
