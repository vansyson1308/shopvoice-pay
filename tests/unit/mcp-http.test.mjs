import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer, connectClient, TOKEN_A, TOKEN_B } from './mcp-harness.mjs';
import { isOriginAllowed } from '../../apps/mcp-server/dist/http.js';

const INIT = (protocolVersion) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-test', version: '1.0.0' } }
});

async function rawInit(url, { token = TOKEN_A, origin, protocolVersion = '2025-11-25' } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(INIT(protocolVersion)) });
}

test('initialize negotiates MCP protocol 2025-11-25 and returns a session id', async () => {
  const srv = await startMcpServer();
  try {
    const res = await rawInit(srv.url);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('mcp-session-id'), 'session id header');
    const body = await res.json();
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.serverInfo.name, 'shopvoice');
    assert.ok(body.result.capabilities.tools);
    assert.ok(body.result.capabilities.prompts);
    assert.ok(body.result.capabilities.resources);
  } finally {
    await srv.close();
  }
});

test('older supported protocol versions are still negotiated', async () => {
  const srv = await startMcpServer();
  try {
    const body = await (await rawInit(srv.url, { protocolVersion: '2025-06-18' })).json();
    assert.equal(body.result.protocolVersion, '2025-06-18');
  } finally {
    await srv.close();
  }
});

test('SDK client lists all tools with annotations and output schemas', async () => {
  const srv = await startMcpServer();
  const { client } = await connectClient(srv.url);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'confirm_reorder', 'create_reorder_draft', 'get_daily_briefing', 'get_invoice_status', 'get_low_stock',
      'get_sales_summary', 'get_stock_level', 'get_top_movers', 'suggest_reorder'
    ]);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, 'object', `${tool.name} outputSchema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.equal(typeof tool.annotations?.idempotentHint, 'boolean', `${tool.name} idempotentHint`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.confirm_reorder.annotations.destructiveHint, true);
    assert.equal(byName.create_reorder_draft.annotations.readOnlyHint, false);
    assert.equal(byName.create_reorder_draft.annotations.destructiveHint, false);
    assert.equal(byName.get_low_stock.annotations.readOnlyHint, true);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ['morning_briefing']);
    const prompt = await client.getPrompt({ name: 'morning_briefing' });
    assert.match(prompt.messages[0].content.text, /get_daily_briefing/);

    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ['shop://profile']);
    const profile = await client.readResource({ uri: 'shop://profile' });
    assert.deepEqual(JSON.parse(profile.contents[0].text), {
      shop_name: 'Corner Mart Demo', display_currency: 'USD', vnd_per_display_unit: 25000, timezone: 'Asia/Ho_Chi_Minh', locale: 'en-US'
    });
  } finally {
    await client.close();
    await srv.close();
  }
});

test('missing or wrong bearer token gets 401 with WWW-Authenticate', async () => {
  const srv = await startMcpServer();
  try {
    const none = await rawInit(srv.url, { token: null });
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer realm="shopvoice"/);
    const wrong = await rawInit(srv.url, { token: 'sv_wrong_token_value_0000000000000000000000' });
    assert.equal(wrong.status, 401);
  } finally {
    await srv.close();
  }
});

test('repeated auth failures from one IP are rate limited', async () => {
  const srv = await startMcpServer({ env: { MCP_AUTH_FAILURES_PER_MINUTE: '3' } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await rawInit(srv.url, { token: `sv_bad_${i}_000000000000000000000000000000` })).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  } finally {
    await srv.close();
  }
});

test('per-tenant request rate limit returns 429', async () => {
  const srv = await startMcpServer({ env: { MCP_RATE_LIMIT_PER_MINUTE: '2' } });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await rawInit(srv.url)).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await srv.close();
  }
});

test('Origin header is validated against the allow-list', async () => {
  const srv = await startMcpServer();
  try {
    assert.equal((await rawInit(srv.url, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await rawInit(srv.url, { origin: 'http://localhost:6274' })).status, 403, 'localhost not allowed when disabled');
    const ok = await rawInit(srv.url, { origin: 'https://sim.example' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://sim.example');
  } finally {
    await srv.close();
  }
  assert.equal(isOriginAllowed(undefined, [], false), true, 'server-to-server clients send no Origin');
  assert.equal(isOriginAllowed('http://localhost:6274', [], true), true);
  assert.equal(isOriginAllowed('http://localhost.evil.com', [], true), false);
  assert.equal(isOriginAllowed('null', [], true), false);
});

test('a session is bound to its tenant: another tenant token cannot reuse it', async () => {
  const srv = await startMcpServer();
  try {
    const init = await rawInit(srv.url);
    const sessionId = init.headers.get('mcp-session-id');
    const call = (token) => fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert.equal((await call(TOKEN_B)).status, 404);
    assert.equal((await call(TOKEN_A)).status, 200);
  } finally {
    await srv.close();
  }
});

test('non-initialize request without session is rejected; unknown session is 404', async () => {
  const srv = await startMcpServer();
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN_A}` };
    const noSession = await fetch(`${srv.url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(noSession.status, 400);
    const unknown = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': 'nope' }, body: '{}' });
    assert.equal(unknown.status, 404);
    const badJson = await fetch(`${srv.url}/mcp`, { method: 'POST', headers, body: '{not json' });
    assert.equal(badJson.status, 400);
  } finally {
    await srv.close();
  }
});

test('healthz and readyz respond without auth', async () => {
  const srv = await startMcpServer();
  try {
    const h = await fetch(`${srv.url}/healthz`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).status, 'ok');
    const r = await fetch(`${srv.url}/readyz`);
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${srv.url}/nope`)).status, 404);
  } finally {
    await srv.close();
  }
});

test('DELETE closes the session', async () => {
  const srv = await startMcpServer();
  const { client, transport } = await connectClient(srv.url);
  try {
    assert.equal(srv.handler.sessionCount(), 1);
    await transport.terminateSession();
    assert.equal(srv.handler.sessionCount(), 0);
  } finally {
    await client.close();
    await srv.close();
  }
});

test('X-Origin-Verify gate: only requests carrying the CloudFront secret get through', async () => {
  const srv = await startMcpServer({ env: { ORIGIN_VERIFY_SECRET: 'cf-secret-123' } });
  try {
    assert.equal((await fetch(`${srv.url}/healthz`)).status, 200, 'health stays open for load balancer checks');
    assert.equal((await fetch(`${srv.url}/readyz`)).status, 403);
    assert.equal((await rawInit(srv.url)).status, 403);
    const ok = await fetch(`${srv.url}/readyz`, { headers: { 'x-origin-verify': 'cf-secret-123' } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${srv.url}/readyz`, { headers: { 'x-origin-verify': 'wrong' } })).status, 403);
  } finally {
    await srv.close();
  }
});
