// Shared helpers for ShopVoice MCP tests (not a test file itself).
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpHandler } from '../../apps/mcp-server/dist/http.js';
import { loadMcpServerConfig } from '../../apps/mcp-server/dist/config.js';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { loadPaymentsSetup, connectMockPayPal } from '../../apps/mcp-server/dist/payments-setup.js';
import { createOwnerApi } from '../../apps/mcp-server/dist/owner-api.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildDemoDataset, DEMO_TENANT_ID } from '../../scripts/gen_demo_seed.mjs';

export const ANCHOR = '2026-09-25'; // a Friday
export const TOKEN_A = 'sv_test_demo_tenant_token_aaaaaaaaaaaaaaaaaaaaaaaa';
export const TOKEN_B = 'sv_test_other_tenant_token_bbbbbbbbbbbbbbbbbbbbbbb';
export const TENANT_B = 'b0b0b0b0-0000-4000-8000-000000000002';
export { DEMO_TENANT_ID };

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Demo dataset plus a second tenant ("Other Shop") that shares no data with the demo tenant. */
export function twoTenantDataset() {
  const base = buildDemoDataset({ anchorDate: ANCHOR, tokens: { [TOKEN_A]: DEMO_TENANT_ID, [TOKEN_B]: TENANT_B } });
  base.tenants[TENANT_B] = {
    profile: { shopName: 'Other Shop', displayCurrency: 'USD', minorPerUnit: 100, timezone: 'America/Chicago', locale: 'en-US' },
    today: ANCHOR,
    products: [{ sku: 'B-ONLY', name: 'Secret Tenant B Tea', unit: 'box', barcode: '999', onHand: 1, minQty: 5, reorderQty: 10, packSize: 1, unitCostMinor: 1000, supplierCode: 'SUP-B', leadTimeDays: 1 }],
    sales: [{ date: ANCHOR, sku: 'B-ONLY', qty: 3, revenueMinor: 3000 }],
    suppliers: [{ code: 'SUP-B', name: 'Tenant B Supplier', leadTimeDays: 1 }],
    invoices: []
  };
  return base;
}

export const TEST_MEK = Buffer.alloc(32, 9).toString('base64');

/** Mock PayPal + PaymentsService on the given clock (align it with the dataset's anchor date). */
export function mockPayments(clock = () => Date.parse(`${ANCHOR}T15:00:00Z`), env = {}) {
  return loadPaymentsSetup({ PAYPAL_MODE: 'mock', APP_MEK_B64: TEST_MEK, CONSOLE_PUBLIC_URL: 'https://console.test', ...env }, silentLogger, clock);
}

export async function startMcpServer({ env = {}, store, clock, payments = null, connectTenants = [DEMO_TENANT_ID], resetDemo = null } = {}) {
  const config = loadMcpServerConfig({ MCP_DATA_BACKEND: 'memory', MCP_ALLOW_LOCALHOST_ORIGINS: 'false', MCP_ALLOWED_ORIGINS: 'https://sim.example', ...env });
  const shopStore = store ?? new MemoryShopStore(twoTenantDataset(), clock);
  if (payments) for (const tenantId of connectTenants) await connectMockPayPal(payments, shopStore, tenantId);
  const owner = payments ? createOwnerApi({ store: shopStore, payments, logger: silentLogger, ...(resetDemo ? { resetDemo } : {}) }) : undefined;
  const handler = createMcpHttpHandler({ store: shopStore, config, logger: silentLogger, ...(payments ? { payments: payments.service, owner } : {}) });
  const server = createServer((req, res) => { void handler.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    store: shopStore,
    payments,
    handler,
    async close() {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * capabilities: e.g. { elicitation: { form: {}, url: {} } }. onElicit(params)
 * answers elicitation requests ({ action, content }) and records them.
 */
export async function connectClient(baseUrl, token = TOKEN_A, { capabilities, onElicit } = {}) {
  const client = new Client({ name: 'shopvoice-test', version: '1.0.0' }, capabilities ? { capabilities } : undefined);
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request) => onElicit(request.params));
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

export function spoken(result) {
  return result.content?.[0]?.text ?? '';
}

export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
