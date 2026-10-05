// "Try the demo": every console visitor gets a private sample shop, so one
// judge's orders and approvals never show up in another's console. Covers the
// provisioning endpoint, per-visitor sessions, rate limits and reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { MemoryDemoShops } from '../../apps/mcp-server/dist/demo-shops.js';
import { createSimHandler, loadSimConfig } from '../../apps/console/dist/server.js';
import { RulesBrain } from '../../apps/console/dist/brain.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { buildSandboxTenantData } from '../../scripts/gen_demo_seed.mjs';
import { startMcpServer, twoTenantDataset, mockPayments, silentLogger, DEMO_TENANT_ID, ANCHOR } from './mcp-harness.mjs';

const SECRET = 'provision-secret-0123456789abcdef';
const clock = () => Date.parse(`${ANCHOR}T15:00:00Z`);

async function stack() {
  const payments = mockPayments(clock);
  const store = new MemoryShopStore(twoTenantDataset(), clock);
  const demoShops = new MemoryDemoShops(store, () => buildSandboxTenantData('en', ANCHOR), payments, new Set([DEMO_TENANT_ID]), clock);
  const mcp = await startMcpServer({ store, payments, demoShops, resetDemo: (t) => demoShops.reset(t), env: { DEMO_PROVISION_SECRET: SECRET } });
  const config = loadSimConfig({ SIM_MCP_URL: `${mcp.url}/mcp`, DEMO_PROVISION_SECRET: SECRET, DEMO_ANCHOR_DATE: ANCHOR });
  const handler = createSimHandler({
    config, logger: silentLogger, toolbox: new McpToolbox(config.mcpUrl, 'unused-in-visitor-mode-0000'), brain: new RulesBrain(), fallbackBrain: new RulesBrain(),
    speech: new BrowserSpeech(), staticDir: fileURLToPath(new URL('../../apps/console/static/', import.meta.url))
  });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { mcp, url, handler, store, async close() { await new Promise((r) => server.close(r)); await mcp.close(); } };
}

/** A browser: keeps its own session cookie. */
function visitor(base) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), setCookie: set, json: text ? JSON.parse(text) : null };
  };
}

test('provisioning endpoint: only the console, with the shared secret', async () => {
  const s = await stack();
  try {
    const post = (headers) => fetch(`${s.mcp.url}/owner/demo-shops`, { method: 'POST', headers });
    assert.equal((await post({})).status, 404);
    assert.equal((await post({ 'x-demo-provision-secret': 'wrong' })).status, 404);
    assert.equal((await post({ 'x-demo-provision-secret': SECRET, origin: 'https://evil.example' })).status, 404);
    const ok = await post({ 'x-demo-provision-secret': SECRET });
    assert.equal(ok.status, 201);
    assert.match((await ok.json()).token, /^sv_demo_[A-Za-z0-9_-]{43}$/);
  } finally {
    await s.close();
  }
});

test('each visitor gets a private shop; orders in one never show in another', async () => {
  const s = await stack();
  try {
    const a = visitor(s.url);
    const b = visitor(s.url);
    assert.equal((await a('GET', '/api/owner/overview')).status, 401, 'no shop before "Try the demo"');
    const started = await a('POST', '/api/session');
    assert.equal(started.status, 201);
    assert.match(started.setCookie, /^svc_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=14400$/);
    assert.equal((await a('POST', '/api/session')).status, 200, 'the same browser keeps its shop');
    assert.equal((await b('POST', '/api/session')).status, 201);

    const before = (await b('GET', '/api/owner/ledger')).json.payments.length;
    const drafted = await a('POST', '/api/turn', { text: 'Reorder milk and eggs' });
    const confirmed = await a('POST', '/api/turn', { text: 'Yes, confirm', conversationId: drafted.json.conversationId });
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.json.toolCalls.some((t) => t.name === 'confirm_reorder'));
    assert.deepEqual((await a('GET', '/api/owner/approvals')).json.approvals.map((x) => x.supplier_code), ['SUP-EGGS']);
    assert.deepEqual((await b('GET', '/api/owner/approvals')).json.approvals, [], "visitor B does not see A's approval");
    assert.equal((await b('GET', '/api/owner/ledger')).json.payments.length, before);
    assert.equal((await a('GET', '/api/owner/overview')).json.paypal.connected, true, 'simulated PayPal account in mock mode');

    // Reset puts A back to the sample data and starts a fresh conversation.
    const reset = await a('POST', '/api/owner/demo/reset', {});
    assert.equal(reset.status, 200);
    assert.deepEqual((await a('GET', '/api/owner/approvals')).json.approvals, []);
    assert.equal((await a('GET', '/api/owner/ledger')).json.payments.length, before);
    assert.equal((await a('GET', '/api/owner/overview')).json.paypal.connected, true);
    assert.equal(s.handler.visitorSessions(), 2);
  } finally {
    await s.close();
  }
});

test('new demo shops are rate limited per visitor address; PayPal returns need a session', async () => {
  const s = await stack();
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await visitor(s.url)('POST', '/api/session')).status);
    assert.deepEqual(statuses, [201, 201, 201, 429]);
    const stranger = visitor(s.url);
    const back = await stranger('GET', '/paypal/approved?payment=00000000-0000-4000-8000-000000000000');
    assert.equal(back.status, 303);
    assert.equal(back.location, '/');
  } finally {
    await s.close();
  }
});

test('voice-turn probe: read-only questions in a visitor shop, p50/p95 reported', async () => {
  const { probe, summarize, QUESTIONS } = await import('../../scripts/demo/voice_turn_probe.mjs');
  const s = await stack();
  try {
    const samples = await probe(s.url, 2);
    assert.equal(samples.length, QUESTIONS.length * 2);
    for (const sample of samples) assert.ok(sample.roundTripMs > 0 && sample.brain === 'rules', JSON.stringify(sample));
    const summary = summarize(samples);
    assert.equal(summary.turns, 8);
    assert.equal(summary.brain, 'rules');
    assert.ok(summary.p50_ms <= summary.p95_ms && summary.p95_ms <= summary.max_ms);
    assert.equal(typeof summary.under_3s_p50, 'boolean');
  } finally {
    await s.close();
  }
});
