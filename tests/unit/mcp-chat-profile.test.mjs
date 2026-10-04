// MCP behaviour for Claude (OAuth "chat" clients): tool metadata that passes
// the directory review rules, markdown content next to structuredContent, the
// two-step reorder without a voice host, Origin handling and actionable errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOAuthServer, dcrClient, fullGrant, mcpPost, mcpSession, callTool, INIT } from './oauth-harness.mjs';
import { TOKEN_A } from './mcp-harness.mjs';
import { CHAT_INSTRUCTIONS } from '../../apps/mcp-server/dist/mcp.js';

let n = 0;
const email = () => `chat${++n}-${Date.now()}@example.com`;

async function oauthToken(srv, scope) {
  const clientId = await dcrClient(srv);
  return (await fullGrant(srv, { clientId, email: email(), ...(scope ? { scope } : {}) })).access_token;
}

async function listTools(srv, token, session) {
  const res = await mcpPost(srv, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { token, session });
  return (await res.json()).result.tools;
}

// Patterns the connector review rejects in tool descriptions: instructions to
// the model, calls to other software, overriding instructions, promotion.
const INJECTION = [/\bONLY\b/, /\byou (must|should)\b/i, /\balways\b/i, /\bnever call\b/i, /\bignore\b/i, /\bsystem prompt\b/i,
  /\bread (it|the .*) (aloud|to the user)\b/i, /\bask the user\b/i, /\bAlexa\b/, /\bbest\b/i, /https?:\/\//];

test('tool metadata: titles, read/write hints, short names, neutral descriptions', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const s = await mcpSession(srv, token);
    const tools = await listTools(srv, token, s.session);
    assert.equal(tools.length, 9);
    for (const t of tools) {
      assert.ok(t.name.length <= 64, t.name);
      assert.ok(t.title && t.annotations?.title, `${t.name} has a title`);
      const hint = t.annotations.readOnlyHint === true || t.annotations.destructiveHint !== undefined;
      assert.ok(hint, `${t.name} declares readOnlyHint or destructiveHint`);
      assert.ok(t.outputSchema, `${t.name} has an outputSchema`);
      for (const re of INJECTION) assert.doesNotMatch(t.description, re, `${t.name}: ${re}`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.confirm_reorder.annotations.destructiveHint, true, 'Claude asks the user before confirm_reorder');
    assert.equal(byName.create_reorder_draft.annotations.readOnlyHint, false);
    assert.equal(byName.create_reorder_draft.annotations.destructiveHint, false);
    const reads = tools.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name).sort();
    assert.deepEqual(reads, ['get_daily_briefing', 'get_invoice_status', 'get_low_stock', 'get_sales_summary', 'get_stock_level', 'get_top_movers', 'suggest_reorder']);
  } finally {
    await srv.close();
  }
});

test('server instructions: neutral chat text for OAuth clients, voice text for the simulator', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const chat = await (await mcpPost(srv, INIT, { token })).json();
    assert.equal(chat.result.instructions, CHAT_INSTRUCTIONS);
    const sentences = CHAT_INSTRUCTIONS.split(/(?<=\.)\s+/).length;
    assert.ok(sentences >= 2 && sentences <= 3, `2-3 sentences, got ${sentences}`);
    for (const re of [/\bONLY\b/, /\byou (must|should)\b/i]) assert.doesNotMatch(CHAT_INSTRUCTIONS, re);
    const voice = await (await mcpPost(srv, INIT, { token: TOKEN_A })).json();
    assert.match(voice.result.instructions, /by voice/);
  } finally {
    await srv.close();
  }
});

test('chat profile: every tool returns markdown plus structuredContent, reasonably sized', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const s = await mcpSession(srv, token);
    const calls = [
      ['get_daily_briefing', {}, /\*\*Daily shop briefing\*\*/],
      ['get_low_stock', {}, /\| Product \| On hand \| Minimum \|/],
      ['get_stock_level', { product: 'whole milk' }, /\*\*Whole milk 1 gal \(crate of 2\)\*\*: \d+ crates? on hand/],
      ['get_sales_summary', { period: 'yesterday' }, /\*\*Sales, yesterday/],
      ['get_top_movers', { period: 'last_7_days', metric: 'revenue', limit: 5 }, /\| # \| Product \| Units \| Revenue \|/],
      ['get_invoice_status', {}, /Posted to inventory|Matched, not posted/],
      ['suggest_reorder', {}, /\*\*Suggested reorder:/],
      ['create_reorder_draft', { items: [{ product: 'whole milk' }] }, /confirmation_token: `/]
    ];
    for (const [name, args, re] of calls) {
      const r = await callTool(srv, token, s.session, name, args);
      assert.equal(r.res.status, 200, name);
      const result = r.json.result;
      assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
      assert.ok(result.structuredContent, `${name} structuredContent`);
      assert.match(result.content[0].text, re, name);
      assert.ok(result.content[0].text.length < 6000, `${name} markdown is compact`);
      if (name !== 'get_stock_level' && name !== 'get_daily_briefing' && name !== 'get_sales_summary') {
        assert.doesNotMatch(result.content[0].text, /undefined|NaN/, name);
      }
    }
  } finally {
    await srv.close();
  }
});

test('reorder in Claude: the draft token is visible to the model; confirm is a separate, destructive call', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const s = await mcpSession(srv, token);
    const draft = await callTool(srv, token, s.session, 'create_reorder_draft', { items: [{ product: 'eggs', qty: 30 }] });
    const sc = draft.json.result.structuredContent;
    assert.equal(sc.status, 'draft_created');
    assert.match(sc.confirmation_token, /^[A-Za-z0-9_-]{8,64}$/);
    assert.ok(draft.json.result.content[0].text.includes(sc.confirmation_token));
    assert.match(draft.json.result.content[0].text, /Not placed yet/);
    const confirmed = await callTool(srv, token, s.session, 'confirm_reorder', { confirmation_token: sc.confirmation_token });
    assert.equal(confirmed.json.result.structuredContent.status, 'confirmed');
    assert.match(confirmed.json.result.content[0].text, /no payment was made/);
    const again = await callTool(srv, token, s.session, 'confirm_reorder', { confirmation_token: sc.confirmation_token });
    assert.equal(again.json.result.structuredContent.status, 'already_confirmed', 'single use');
  } finally {
    await srv.close();
  }
});

test('Origin: server-to-server requests without Origin are accepted (Anthropic egress); foreign browser origins are refused', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const noOrigin = await mcpPost(srv, INIT, { token });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
    const evil = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: JSON.stringify(INIT) });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error.message, /Origin/);
  } finally {
    await srv.close();
  }
});

test('errors are specific and actionable for chat clients', async () => {
  const srv = await startOAuthServer();
  try {
    const token = await oauthToken(srv);
    const s = await mcpSession(srv, token);
    const bad = await callTool(srv, token, s.session, 'get_sales_summary', { period: 'custom', start_date: '2099-01-01' });
    assert.equal(bad.json.result.isError, true);
    assert.match(bad.json.result.content[0].text, /YYYY-MM-DD dates in the past/);
    const lost = await mcpPost(srv, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { token, session: 'no-such-session' });
    assert.equal(lost.status, 404);
    assert.match((await lost.json()).error.message, /Start a new MCP session/);
    const garbage = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: '{not json' });
    assert.equal(garbage.status, 400);
    assert.match((await garbage.json()).error.message, /not valid JSON/);
  } finally {
    await srv.close();
  }
});
