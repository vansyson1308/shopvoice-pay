#!/usr/bin/env node
// Spike §4.5: @paypal/agent-toolkit and PayPal's remote MCP server in sandbox.
//
//   PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   SPIKE_BUYER_EMAIL=<sandbox personal email> [SPIKE_CAPTURE_ID=... SPIKE_ORDER_ID=...] \
//   node scripts/paypal/toolkit-spike.mjs
//
// Tools are called directly through the toolkit's API service, not via an
// LLM: the point is to learn exactly what each tool sends and returns before
// ShopVoice Pay wraps them behind its policy layer. In mock mode the script
// only lists the tools (the toolkit has its own HTTP client and would reach
// the real sandbox).
import { writeFileSync, mkdirSync } from 'node:fs';
import { PayPalMCPToolkit } from '@paypal/agent-toolkit/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPayPalRuntime, newRequestId, createOrder, firstCapture, PayPalApiError } from '../../apps/mcp-server/dist/payments/index.js';

const env = process.env;
const runtime = createPayPalRuntime(env);
const mode = runtime.config.mode;
const results = [];

const ACTIONS = {
  invoices: { create: true, send: true, get: true, list: true },
  orders: { get: true },
  payments: { createRefund: true, getRefunds: true },
  shipment: { create: true, get: true },
  transactions: { list: true },
  insights: { get: true }
};

async function check(id, title, fn) {
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    const { status = 'pass', evidence = {}, value } = (await fn()) ?? {};
    results.push({ id, title, status, ms: Date.now() - started, evidence });
    console.log(`  -> ${status.toUpperCase()} ${JSON.stringify(evidence).slice(0, 400)}`);
    return value;
  } catch (error) {
    const evidence = error instanceof PayPalApiError ? { http_status: error.status, issue: error.code } : { error: String(error?.message ?? error).slice(0, 300) };
    results.push({ id, title, status: 'fail', ms: Date.now() - started, evidence });
    console.log(`  -> FAIL ${JSON.stringify(evidence)}`);
    return undefined;
  }
}

/** The toolkit returns JSON strings, or an error string; normalise both. */
function parseToolResult(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 300) };
  }
}

const accessToken = mode === 'sandbox' ? await runtime.client.accessToken() : 'mock-token';
const toolkit = new PayPalMCPToolkit({ accessToken, configuration: { actions: ACTIONS, context: { sandbox: true } } });
const api = toolkit.getPaypalAPIService();
const run = async (method, args) => parseToolResult(await api.run(method, args));

await check('T0', 'Toolkit tools available for ShopVoice Pay', async () => ({
  evidence: { version: '1.11.0', tools: toolkit.getTools().map((t) => t.method) }
}));

if (mode === 'sandbox') {
  const buyer = env.SPIKE_BUYER_EMAIL;
  const invoice = await check('T1', 'create_invoice (store sells a catering tray)', async () => {
    if (!buyer) return { status: 'skipped', evidence: { reason: 'SPIKE_BUYER_EMAIL not set' } };
    const out = await run('create_invoice', {
      currency_code: 'USD',
      reference: 'CATERING-SPIKE',
      note: 'Catering tray for Saturday pickup (sandbox spike)',
      invoicer_business_name: 'Corner Store (sandbox)',
      primary_recipients: [{ billing_info: { email_address: buyer } }],
      items: [{ name: 'Sandwich platter, serves 10', quantity: '1', unit_amount: { currency_code: 'USD', value: '45.00' } }]
    });
    const href = out.href ?? out.links?.[0]?.href ?? null;
    return { evidence: { keys: Object.keys(out), href_present: !!href }, value: href ? href.split('/').pop() : out.id };
  });
  if (invoice) {
    await check('T2', 'send_invoice', async () => ({ evidence: { result: Object.keys(await run('send_invoice', { invoice_id: invoice, send_to_recipient: true })) } }));
  }

  const orderId = env.SPIKE_ORDER_ID || await check('T3.0', 'create an order with our own client for get_order', async () => {
    const order = await createOrder(runtime.client, {
      intent: 'AUTHORIZE',
      purchaseUnit: { referenceId: 'toolkit', description: 'Toolkit spike', amount: { amountMinor: 1000, currency: 'USD' } },
      paymentSource: { kind: 'paypal_approval', returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', brandName: 'ShopVoice Pay (sandbox)' },
      requestId: newRequestId('tk-order')
    });
    return { evidence: { status: order.status }, value: order.id };
  });
  if (orderId) {
    await check('T3', 'get_order', async () => {
      const out = await run('get_order', { id: orderId });
      return { evidence: { status: out.status ?? null, intent: out.intent ?? null } };
    });
  }

  let captureId = env.SPIKE_CAPTURE_ID;
  if (!captureId && env.SPIKE_VAULT_ID) {
    captureId = await check('T4.0', 'vaulted CAPTURE order to get a capture id', async () => {
      const order = await createOrder(runtime.client, {
        intent: 'CAPTURE',
        purchaseUnit: { referenceId: 'toolkit-capture', description: 'Toolkit spike capture', amount: { amountMinor: 2400, currency: 'USD' } },
        paymentSource: { kind: 'vault', vaultId: env.SPIKE_VAULT_ID },
        requestId: newRequestId('tk-vault-order')
      });
      return { evidence: { status: order.status }, value: firstCapture(order)?.id };
    });
  }
  if (captureId) {
    await check('T4', 'create_shipment_tracking on a captured transaction', async () => {
      const out = await run('create_shipment_tracking', { transaction_id: captureId, tracking_number: `SV${Date.now()}`, status: 'SHIPPED', carrier: 'OTHER' });
      return { evidence: { keys: Object.keys(out).slice(0, 8) } };
    });
    await check('T5', 'get_shipment_tracking', async () => ({ evidence: { keys: Object.keys(await run('get_shipment_tracking', { transaction_id: captureId })).slice(0, 8) } }));
    await check('T6', 'create_refund (partial)', async () => {
      const out = await run('create_refund', { capture_id: captureId, amount: { currency_code: 'USD', value: '1.00' }, note_to_payer: 'Toolkit spike refund' });
      return { evidence: { status: out.status ?? null, keys: Object.keys(out).slice(0, 6) } };
    });
  } else {
    results.push({ id: 'T4-T6', title: 'shipment tracking + refund via toolkit', status: 'skipped', evidence: { reason: 'set SPIKE_CAPTURE_ID or SPIKE_VAULT_ID (from spike S3.1)' } });
  }

  await check('T7', 'list_transactions (last 30 days)', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    const out = await run('list_transactions', { start_date: start.toISOString(), end_date: end.toISOString() });
    return { evidence: { keys: Object.keys(out).slice(0, 8), count: out.transaction_details?.length ?? null } };
  });
  await check('T8', 'get_merchant_insights (docs say sandbox throws)', async () => {
    const out = await run('get_merchant_insights', { start_date: '2026-09-01', end_date: '2026-10-01', insight_type: 'ORDERS', time_interval: 'WEEKLY' }).catch((e) => ({ error: String(e?.message ?? e) }));
    return { status: 'info', evidence: { keys: Object.keys(out).slice(0, 6), error: out.error?.slice?.(0, 200) ?? null } };
  });

  // Probed 2026-10-04: POST /mcp -> 401 (Streamable HTTP), /http -> 404, /sse -> 401 (legacy SSE).
  // The server advertises OAuth 2.1 authorization_code + PKCE with DCR; this checks whether
  // a REST client-credentials token is also accepted as the bearer.
  await check('T9', 'Remote PayPal MCP server (mcp.sandbox.paypal.com/mcp) with a REST bearer token', async () => {
    const client = new Client({ name: 'shopvoice-pay-spike', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.sandbox.paypal.com/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();
    return { evidence: { tool_count: tools.tools.length, sample: tools.tools.slice(0, 10).map((t) => t.name) } };
  });
}

const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
mkdirSync('docs/paypal', { recursive: true });
const out = `docs/paypal/toolkit-spike-results.${mode}.json`;
writeFileSync(out, `${JSON.stringify({ mode, ran_at: new Date().toISOString(), summary, results }, null, 2)}\n`);
console.log(`\nSummary: ${JSON.stringify(summary)} -> ${out}`);
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
