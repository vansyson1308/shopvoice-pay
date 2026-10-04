// Payment tools over the real MCP protocol, with the mock PayPal (calibrated
// to the sandbox) and the US demo seed. Covers the hero story (milk autopays,
// eggs need approval), each approval path the owner chose for M2, deliveries,
// refunds and rule changes, and the safety contract: no approval token, vault
// id or PayPal authorization/capture id ever reaches tool output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decryptPayload } from '../../packages/common/dist/index.js';
import { autoCommitRepository } from '../../apps/mcp-server/dist/auto-commit.js';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { startMcpServer, connectClient, twoTenantDataset, mockPayments, spoken, wordCount, DEMO_TENANT_ID, TEST_MEK, ANCHOR } from './mcp-harness.mjs';
import { startOAuthServer, dcrClient, fullGrant } from './oauth-harness.mjs';

const NOW = Date.parse(`${ANCHOR}T15:00:00Z`);
const clock = () => NOW;
let n = 0;

/** Records every approval token PaymentsService hands out, so tests can prove none leaks. */
function spyTokens(setup) {
  const tokens = [];
  const pay = setup.service.payForDraft.bind(setup.service);
  setup.service.payForDraft = async (...args) => {
    const result = await pay(...args);
    if (result.approval) tokens.push(result.approval.token);
    return result;
  };
  return tokens;
}

async function ledger(store, tenantId) {
  return store.withTenant(tenantId, (repo) => repo.payments.listPayments({ limit: 100 }));
}

/** PayPal authorization/capture ids and the vault id for a tenant: none may appear in tool output. */
async function secretIds(store, tenantId) {
  const payments = await ledger(store, tenantId);
  const method = await store.withTenant(tenantId, (repo) => repo.payments.getActivePaymentMethod());
  const vault = method ? JSON.parse(decryptPayload(method.sealed, TEST_MEK)).vaultId : null;
  return [...payments.flatMap((p) => [p.paypalAuthorizationId, ...p.paypalCaptureIds]), vault].filter(Boolean);
}

function assertNoSecrets(text, secrets, label) {
  for (const s of secrets) assert.ok(!text.includes(s), `${label} leaked ${s.slice(0, 6)}…`);
}

async function draftMilkAndEggs(client) {
  const draft = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'milk' }, { product: 'eggs' }] } });
  assert.equal(draft.structuredContent.status, 'draft_created', spoken(draft));
  return draft.structuredContent.confirmation_token;
}

// ---------- the owner's own console (static bearer, voice profile) ----------

test('console: milk auto-pays and is held; eggs wait for the owner; nothing secret reaches the model', async () => {
  const payments = mockPayments(clock);
  const tokens = spyTokens(payments);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  const outputs = [];
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
    assert.ok(!r.isError, `${name}: ${spoken(r)}`);
    assert.ok(wordCount(spoken(r)) <= 35, `${name} spoke ${wordCount(spoken(r))} words: ${spoken(r)}`);
    return r;
  };
  try {
    const token = await draftMilkAndEggs(client);
    const before = (await ledger(srv.store, DEMO_TENANT_ID)).length;
    const r = await call('confirm_reorder', { confirmation_token: token });
    const d = r.structuredContent;
    assert.equal(d.status, 'confirmed');
    assert.equal(d.payments_enabled, true);
    const by = Object.fromEntries(d.payments.map((p) => [p.supplier_code, p]));

    assert.equal(by['SUP-DAIRY'].decision, 'autopay');
    assert.equal(by['SUP-DAIRY'].status, 'authorized');
    assert.equal(by['SUP-DAIRY'].held_minor, 8400, '$84 held');
    assert.equal(by['SUP-DAIRY'].charged_minor, 0, 'not charged before delivery');
    assert.equal(by['SUP-DAIRY'].approval.state, 'not_needed');
    assert.equal(Date.parse(by['SUP-DAIRY'].honor_period_ends_at) - NOW, 3 * 86_400_000, 'honor period ends after 3 days');
    assert.ok(Date.parse(by['SUP-DAIRY'].hold_expires_at) - NOW >= 28 * 86_400_000, 'hold expires after 29 days');

    assert.equal(by['SUP-EGGS'].decision, 'step_up');
    assert.equal(by['SUP-EGGS'].status, 'pending_approval');
    assert.equal(by['SUP-EGGS'].amount_minor, 14200);
    assert.equal(by['SUP-EGGS'].approval.state, 'waiting_in_console');
    assert.equal(by['SUP-EGGS'].approval.approval_url, null);
    assert.ok(by['SUP-EGGS'].reasons.some((x) => /went up 31%/.test(x)), 'the price jump is the reason');
    assert.match(spoken(r), /Northside Dairy \$84 held/);
    assert.match(spoken(r), /Valley Farm Eggs \$142 needs your OK/);
    assert.match(spoken(r), /Large eggs 30 ct is up 31%\./);
    assert.equal((await ledger(srv.store, DEMO_TENANT_ID)).length, before + 2);

    // Confirming again reports the same payments and pays nothing twice.
    const again = await call('confirm_reorder', { confirmation_token: token });
    assert.equal(again.structuredContent.status, 'already_confirmed');
    assert.equal((await ledger(srv.store, DEMO_TENANT_ID)).length, before + 2, 'no second payment');
    assert.equal(again.structuredContent.payments.find((p) => p.supplier_code === 'SUP-DAIRY').held_minor, 8400);

    await call('get_payment_status', { supplier: 'dairy' });
    await call('get_spend_summary');
    await call('explain_payment', { supplier: 'Valley Farm Eggs' });

    assert.ok(tokens.length >= 1, 'an approval token was issued');
    const secrets = [...tokens, ...(await secretIds(srv.store, DEMO_TENANT_ID))];
    assert.ok(secrets.length >= 3);
    for (const [i, out] of outputs.entries()) assertNoSecrets(out, secrets, `call ${i}`);
    const audit = JSON.stringify(srv.store.auditLog);
    assertNoSecrets(audit, secrets, 'audit log');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('status, spend and explain read the ledger without PayPal ids', async () => {
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  try {
    await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    const status = await client.callTool({ name: 'get_payment_status', arguments: { supplier: 'Northside Dairy' } });
    assert.match(spoken(status), /^Northside Dairy, \$84: \$84 held, not charged yet\. The hold lasts until October 24\./);

    const spend = await client.callTool({ name: 'get_spend_summary', arguments: {} });
    assert.equal(spend.structuredContent.pending_approvals, 1);
    assert.equal(spend.structuredContent.held, 84);
    assert.equal(spend.structuredContent.today_committed, 84, 'only money actually held counts');
    assert.match(spoken(spend), /One payment waits for your OK/);

    const why = await client.callTool({ name: 'explain_payment', arguments: { supplier: 'eggs' } });
    assert.equal(why.structuredContent.payment.decision, 'step_up');
    assert.match(spoken(why), /needed your OK: \$142 is over your \$100 auto-pay limit/);
    assert.deepEqual(why.structuredContent.events.map((e) => e.kind), ['policy_evaluated', 'approval_requested']);
    for (const e of why.structuredContent.events) assert.deepEqual(Object.keys(e).sort(), ['actor', 'amount', 'at', 'kind', 'reason']);

    const policy = await client.callTool({ name: 'get_spending_policy', arguments: {} });
    assert.equal(policy.structuredContent.paypal_connected, true);
    assert.match(policy.structuredContent.paypal_account, /\*\*\*/, 'payer email is masked');
    assert.deepEqual(policy.structuredContent.policy.approved_suppliers.map((s) => s.supplier_code), ['SUP-DAIRY', 'SUP-EGGS', 'SUP-BAKERY']);
    assert.match(spoken(policy), /^Auto-pay up to \$100 an order, \$500 a day, \$1,500 a week/);
  } finally {
    await client.close();
    await srv.close();
  }
});

test('delivery: pay only for what arrived, release the rest, pay the supplier; refund takes two steps', async () => {
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  try {
    await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });

    const vague = await client.callTool({ name: 'record_delivery', arguments: { supplier: 'dairy', items: [{ product: 'bananas', received_qty: 3 }] } });
    assert.equal(vague.structuredContent.status, 'needs_clarification');
    assert.match(spoken(vague), /no "bananas"/);

    const r = await client.callTool({ name: 'record_delivery', arguments: { supplier: 'Northside Dairy', items: [{ product: 'whole milk', received_qty: 8 }] } });
    assert.equal(r.structuredContent.status, 'recorded', spoken(r));
    assert.equal(r.structuredContent.outcome, 'partial');
    assert.equal(r.structuredContent.charged, 56, '8 crates x $7');
    assert.equal(r.structuredContent.released, 28);
    assert.equal(r.structuredContent.supplier_paid, 56);
    assert.match(spoken(r), /Charged \$56 for what arrived from Northside Dairy and released \$28/);
    const raw = (await ledger(srv.store, DEMO_TENANT_ID)).find((p) => p.id === r.structuredContent.payment.payment_id);
    assert.equal(raw.capturedMinor, 5600);
    assert.equal(raw.settledMinor, 5600);

    const none = await client.callTool({ name: 'record_delivery', arguments: { supplier: 'Northside Dairy', everything_arrived: true } });
    assert.equal(none.structuredContent.status, 'no_open_order', 'nothing is held any more');

    const ask = await client.callTool({ name: 'request_refund', arguments: { supplier: 'dairy', amount: 14, reason: 'two crates were spoiled' } });
    assert.equal(ask.structuredContent.status, 'needs_confirmation');
    assert.match(spoken(ask), /^Refund \$14 from Northside Dairy to your PayPal\? Say "confirm"/);
    const token = ask.structuredContent.confirmation_token;
    const forged = token.replace('.1400.', '.5600.');
    const bad = await client.callTool({ name: 'request_refund', arguments: { reason: 'x'.repeat(5), confirmation_token: forged } });
    assert.equal(bad.structuredContent.status, 'invalid', 'a token for $14 cannot refund $56');
    const done = await client.callTool({ name: 'request_refund', arguments: { reason: 'two crates were spoiled', confirmation_token: token } });
    assert.equal(done.structuredContent.status, 'refunded', spoken(done));
    assert.equal(done.structuredContent.amount, 14);
    assert.equal(done.structuredContent.payment.refunded_minor, 1400);
    const audit = srv.store.auditLog.filter((a) => a.toolName === 'request_refund');
    assert.ok(audit.every((a) => a.argsRedacted.confirmation_token !== token), 'refund token never stored in the audit log');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('spending rules: tightening applies at once; loosening needs the owner outside the model', async () => {
  const payments = mockPayments(clock);
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const { client } = await connectClient(srv.url);
  try {
    const lower = await client.callTool({ name: 'set_spending_policy', arguments: { per_order_autopay_max: 80 } });
    assert.equal(lower.structuredContent.status, 'applied');
    assert.equal(lower.structuredContent.policy.per_order_autopay_max, 80);

    for (const args of [{ per_order_autopay_max: 500 }, { approve_suppliers: ['Harbor Wholesale'] }, { daily_hard_cap: null }]) {
      const r = await client.callTool({ name: 'set_spending_policy', arguments: args });
      assert.equal(r.structuredContent.status, 'needs_owner', JSON.stringify(args));
      assert.match(spoken(r), /ShopVoice console/);
    }
    const after = await client.callTool({ name: 'get_spending_policy', arguments: {} });
    assert.equal(after.structuredContent.policy.per_order_autopay_max, 80, 'the raise did not happen');
    assert.ok(!after.structuredContent.policy.approved_suppliers.some((s) => s.supplier_code === 'SUP-HARBOR'));

    const invalid = await client.callTool({ name: 'set_spending_policy', arguments: { daily_hard_cap: 100 } });
    assert.equal(invalid.structuredContent.status, 'invalid');
    const unknown = await client.callTool({ name: 'set_spending_policy', arguments: { remove_suppliers: ['Acme Rockets'] } });
    assert.equal(unknown.structuredContent.problem, 'unknown_supplier');

    // A supplier off the approved list is blocked, approval or not.
    const soda = await client.callTool({ name: 'create_reorder_draft', arguments: { items: [{ product: 'paper towels' }] } });
    const blocked = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: soda.structuredContent.confirmation_token } });
    const harbor = blocked.structuredContent.payments[0];
    assert.equal(harbor.supplier_code, 'SUP-HARBOR');
    assert.equal(harbor.status, 'blocked');
    assert.match(spoken(blocked), /Harbor Wholesale not paid/);
  } finally {
    await client.close();
    await srv.close();
  }
});

test('without payments configured, confirm still confirms and says no payment was made', async () => {
  const srv = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock) });
  const { client } = await connectClient(srv.url);
  try {
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    assert.equal(r.structuredContent.payments_enabled, false);
    assert.match(spoken(r), /No payment was made/);
    const status = await client.callTool({ name: 'get_payment_status', arguments: {} });
    assert.match(spoken(status), /not set up/);
  } finally {
    await client.close();
    await srv.close();
  }
});

// ---------- other MCP clients (OAuth, chat profile) ----------

async function oauthClient({ capabilities, onElicit, setup = mockPayments(clock) } = {}) {
  const srv = await startOAuthServer({ clock, payments: setup });
  const clientId = await dcrClient(srv);
  const grant = await fullGrant(srv, { clientId, email: `pay${++n}-${NOW}@example.com` });
  const { client } = await connectClient(srv.url, grant.access_token, { capabilities, onElicit });
  const tenantId = (await srv.oauthStore.resolveAccessToken(sha(grant.access_token))).tenantId;
  return { srv, client, tenantId, setup };
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

test('client with an approval form: the owner approves in the client, the token never reaches the model', async () => {
  const asked = [];
  const setup = mockPayments(clock);
  const tokens = spyTokens(setup);
  const { srv, client, tenantId } = await oauthClient({
    setup,
    capabilities: { elicitation: { form: {} } },
    onElicit: async (params) => { asked.push(params); return { action: 'accept', content: { approve: true } }; }
  });
  try {
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    const eggs = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-EGGS');
    assert.equal(eggs.approval.state, 'approved');
    assert.equal(eggs.approval.method, 'elicitation');
    assert.equal(eggs.status, 'authorized');
    assert.equal(eggs.approved_by, 'owner_elicitation');
    assert.equal(asked.length, 1, 'only the step-up asked');
    assert.equal(asked[0].mode, 'form');
    assert.match(asked[0].message, /^Approve \$142 to Valley Farm Eggs\?/);
    assert.match(asked[0].message, /went up 31%/);
    const secrets = [...tokens, ...(await secretIds(srv.shopStore, tenantId))];
    assertNoSecrets(JSON.stringify(r), secrets, 'tool result');
    assertNoSecrets(JSON.stringify(asked), secrets, 'elicitation request');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('client with an approval form: declining voids the payment', async () => {
  const { srv, client } = await oauthClient({ capabilities: { elicitation: { form: {} } }, onElicit: async () => ({ action: 'decline' }) });
  try {
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    const eggs = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-EGGS');
    assert.equal(eggs.approval.state, 'declined');
    assert.equal(eggs.status, 'voided');
    assert.equal(eggs.held_minor, 0);
    assert.match(spoken(r), /Valley Farm Eggs: not paid\. The owner declined in the client\./, 'chat clients get markdown');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('client without elicitation: a PayPal approval link; approving on PayPal places the hold', async () => {
  const { srv, client, tenantId, setup } = await oauthClient();
  try {
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    const eggs = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-EGGS');
    assert.equal(eggs.approval.state, 'waiting_in_paypal');
    assert.match(eggs.approval.approval_url, /^https:\/\/console\.test\/sim\/paypal\/checkoutnow\?token=/);
    assert.match(spoken(r), /Valley Farm Eggs: the owner approves on PayPal: https:\/\/console\.test\/sim\/paypal\/checkoutnow/);
    assertNoSecrets(JSON.stringify(r), await secretIds(srv.shopStore, tenantId), 'tool result');

    // The owner approves on PayPal; the return route (or a webhook) completes it.
    const orderId = new URL(eggs.approval.approval_url).searchParams.get('token');
    setup.runtime.mock.approveOrder(orderId);
    const ctx = { repo: autoCommitRepository(srv.shopStore, tenantId).payments, correlationId: 'test', supplierName: (c) => c };
    const done = await setup.service.completeBuyerApproval(ctx, eggs.payment_id);
    assert.equal(done.status, 'authorized');
    assert.equal(done.approvedBy, 'owner_paypal');
    assert.equal(done.heldMinor, 14200);
  } finally {
    await client.close();
    await srv.close();
  }
});

test('client with URL elicitation only: the PayPal link goes to the client, not the model', async () => {
  const opened = [];
  const { srv, client } = await oauthClient({ capabilities: { elicitation: { url: {} } }, onElicit: async (params) => { opened.push(params); return { action: 'accept' }; } });
  try {
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: await draftMilkAndEggs(client) } });
    const eggs = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-EGGS');
    assert.equal(eggs.approval.state, 'waiting_in_paypal');
    assert.equal(eggs.approval.approval_url, null);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].mode, 'url');
    assert.match(opened[0].url, /checkoutnow\?token=/);
    assert.ok(!JSON.stringify(r).includes(opened[0].url), 'the link is not in the tool result');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('client that cannot be reached: the step-up is declined with a clear reason', async () => {
  const { srv, client, setup } = await oauthClient();
  try {
    const token = await draftMilkAndEggs(client);
    setup.runtime.mock.injectFault(400, 1, /\/v2\/checkout\/orders$/);
    const r = await client.callTool({ name: 'confirm_reorder', arguments: { confirmation_token: token } });
    const eggs = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-EGGS');
    assert.equal(eggs.approval.state, 'declined');
    assert.equal(eggs.status, 'voided');
    assert.match(eggs.approval.note, /couldn't get an approval request to you, so I didn't pay/);
    const milk = r.structuredContent.payments.find((p) => p.supplier_code === 'SUP-DAIRY');
    assert.equal(milk.status, 'authorized', 'the auto-pay order is unaffected');
  } finally {
    await client.close();
    await srv.close();
  }
});

test('client with an approval form: raising a limit asks the owner, then applies', async () => {
  const asked = [];
  const { srv, client } = await oauthClient({ capabilities: { elicitation: { form: {} } }, onElicit: async (p) => { asked.push(p); return { action: 'accept', content: { approve: true } }; } });
  try {
    const r = await client.callTool({ name: 'set_spending_policy', arguments: { per_order_autopay_max: 150 } });
    assert.equal(r.structuredContent.status, 'applied');
    assert.equal(r.structuredContent.approved_by, 'elicitation');
    assert.deepEqual(r.structuredContent.looser_changes, ['auto-pay limit']);
    assert.match(asked[0].message, /auto-pay limit/);
  } finally {
    await client.close();
    await srv.close();
  }
});
