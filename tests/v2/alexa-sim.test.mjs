import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { planToolCall, isAffirmative, RulesBrain } from '../../apps/alexa-sim/dist/brain.js';
import { runTurn, newConversation, systemPrompt } from '../../apps/alexa-sim/dist/agent.js';
import { McpToolbox } from '../../apps/alexa-sim/dist/toolbox.js';
import { createSimHandler, loadSimConfig } from '../../apps/alexa-sim/dist/server.js';
import { BrowserSpeech } from '../../apps/alexa-sim/dist/speech.js';
import { startMcpServer, TOKEN_A, silentLogger } from './mcp-harness.mjs';
import { runVoiceFlow, DEMO_UTTERANCES } from '../../scripts/demo/e2e_voice_flow.mjs';

test('rules brain maps demo utterances to the right MCP tools', () => {
  assert.deepEqual(planToolCall("What's running low?"), { name: 'get_low_stock', input: {} });
  assert.deepEqual(planToolCall('How were sales today compared to last Friday?'), { name: 'get_sales_summary', input: { period: 'today', compare_weekday: 'friday' } });
  assert.deepEqual(planToolCall('Reorder milk and eggs'), { name: 'create_reorder_draft', input: { items: [{ product: 'milk' }, { product: 'eggs' }] } });
  assert.equal(planToolCall('Yes, confirm').name, 'confirm_reorder');
  assert.deepEqual(planToolCall('Did the Sunrise Beverages invoice arrive?'), { name: 'get_invoice_status', input: { supplier: 'sunrise beverages' } });
  assert.deepEqual(planToolCall('How many eggs do we have left?'), { name: 'get_stock_level', input: { product: 'eggs' } });
  assert.equal(planToolCall('What were my best sellers this week?').name, 'get_top_movers');
  assert.equal(planToolCall('Give me my morning briefing').name, 'get_daily_briefing');
  assert.equal(planToolCall('Order some bread and cola from my usual supplier').input.items.length, 2);
  assert.equal(planToolCall('tell me a joke'), null);
});

test('affirmative detection rejects hedged or negative answers', () => {
  for (const t of ['yes', 'Yes, confirm', 'go ahead', 'Sure, place it']) assert.equal(isAffirmative(t), true, t);
  for (const t of ['no', "yes wait, don't", 'cancel', 'what?']) assert.equal(isAffirmative(t), false, t);
});

test('system prompt carries the date and the two-step rule', () => {
  const p = systemPrompt('2026-09-25');
  assert.match(p, /2026-09-25/);
  assert.match(p, /confirm_reorder/);
  assert.match(p, /35 words/);
});

/** A brain that always asks to run one fixed tool call first, then echoes the tool text. */
function scriptedBrain(name, input) {
  const seen = [];
  return {
    kind: 'bedrock',
    model: 'scripted',
    seen,
    async converse({ messages }) {
      seen.push(JSON.stringify(messages));
      const last = messages[messages.length - 1];
      if (last.content.some((b) => 'toolResult' in b)) {
        const text = last.content.flatMap((b) => b.toolResult.content.filter((c) => 'text' in c).map((c) => c.text)).join(' ');
        return { content: [{ text }], stopReason: 'end_turn', latencyMs: 1 };
      }
      return { content: [{ toolUse: { toolUseId: 't1', name, input } }], stopReason: 'tool_use', latencyMs: 1 };
    }
  };
}

test('host blocks confirm_reorder unless the owner said yes, and never shows the model the token', async () => {
  const srv = await startMcpServer();
  const toolbox = new McpToolbox(`${srv.url}/mcp`, TOKEN_A);
  try {
    const conversation = newConversation('c1', Date.now());
    const drafted = await runTurn({ conversation, userText: 'Reorder milk', brain: new RulesBrain(), toolbox, today: '2026-09-25', now: Date.now });
    assert.ok(drafted.confirmationCard);
    assert.equal(drafted.confirmationCard.confirmation_token, '[held by host]');
    const realToken = conversation.pending.token;
    assert.match(realToken, /^rc_/);
    assert.ok(!JSON.stringify(conversation.messages).includes(realToken), 'token must not be in model context');

    // A model that tries to confirm on a non-affirmative turn is blocked by the host.
    const eager = scriptedBrain('confirm_reorder', { confirmation_token: 'guess' });
    const blocked = await runTurn({ conversation, userText: 'Hmm, what does that cost?', brain: eager, toolbox, today: '2026-09-25', now: Date.now });
    assert.equal(blocked.toolCalls[0].blockedByHost !== undefined, true);
    assert.equal(blocked.orderResult, null);
    assert.ok(conversation.pending, 'draft still pending');

    // On "yes" the host injects the held token, whatever the model passed.
    const confirmer = scriptedBrain('confirm_reorder', { confirmation_token: 'model-made-this-up' });
    const confirmed = await runTurn({ conversation, userText: 'Yes, go ahead', brain: confirmer, toolbox, today: '2026-09-25', now: Date.now });
    assert.equal(confirmed.orderResult.status, 'confirmed');
    assert.equal(conversation.pending, null);
    for (const seen of [...eager.seen, ...confirmer.seen]) assert.ok(!seen.includes(realToken));
  } finally {
    await toolbox.close();
    await srv.close();
  }
});

async function startSim({ brain, accessCode = '', mcpUrl }) {
  const config = loadSimConfig({ SIM_ACCESS_CODE: accessCode, DEMO_ANCHOR_DATE: '2026-09-25' });
  const toolbox = new McpToolbox(mcpUrl, TOKEN_A);
  const handler = createSimHandler({
    config, logger: silentLogger, toolbox, brain, fallbackBrain: new RulesBrain(), speech: new BrowserSpeech(),
    staticDir: fileURLToPath(new URL('../../apps/alexa-sim/static/', import.meta.url))
  });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { await toolbox.close(); await new Promise((r) => server.close(r)); } };
}

test('e2e: the 5 demo utterances trigger the expected tools (offline rules brain)', async () => {
  const mcp = await startMcpServer();
  const sim = await startSim({ brain: new RulesBrain(), mcpUrl: `${mcp.url}/mcp` });
  try {
    const report = await runVoiceFlow(sim.url);
    assert.equal(report.turns.length, DEMO_UTTERANCES.length);
    for (const t of report.turns) assert.ok(t.ok, `${t.utterance}: ${t.failures.join('; ')}`);
    assert.equal(report.passed, true);
  } finally {
    await sim.close();
    await mcp.close();
  }
});

test('Bedrock failure falls back to the offline brain instead of breaking the demo', async () => {
  const mcp = await startMcpServer();
  const failing = { kind: 'bedrock', model: 'us.amazon.nova-2-lite-v1:0', converse: async () => { throw Object.assign(new Error('bad creds'), { name: 'UnrecognizedClientException' }); } };
  const sim = await startSim({ brain: failing, mcpUrl: `${mcp.url}/mcp` });
  try {
    const res = await fetch(`${sim.url}/api/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: "What's running low?" }) });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.brainFallback, true);
    assert.deepEqual(data.toolCalls.map((c) => c.name), ['get_low_stock']);
  } finally {
    await sim.close();
    await mcp.close();
  }
});

test('simulator security: access code, static traversal, headers, bad input', async () => {
  const mcp = await startMcpServer();
  const sim = await startSim({ brain: new RulesBrain(), accessCode: 'letmein', mcpUrl: `${mcp.url}/mcp` });
  try {
    assert.equal((await fetch(`${sim.url}/api/config`)).status, 401);
    const ok = await fetch(`${sim.url}/api/config`, { headers: { 'x-sim-access': 'letmein' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).brain, 'rules');
    const page = await fetch(`${sim.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /ShopVoice/);
    assert.equal((await fetch(`${sim.url}/static/..%2F..%2Fpackage.json`)).status, 404);
    const bad = await fetch(`${sim.url}/api/turn`, { method: 'POST', headers: { 'x-sim-access': 'letmein', 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${sim.url}/api/turn`, { method: 'POST', headers: { 'x-sim-access': 'letmein' }, body: '{"text":"  "}' });
    assert.equal(empty.status, 400);
    const tts = await fetch(`${sim.url}/api/tts`, { method: 'POST', headers: { 'x-sim-access': 'letmein' }, body: '{"text":"hello"}' });
    assert.equal(tts.status, 204, 'browser speech fallback when Polly is not configured');
  } finally {
    await sim.close();
    await mcp.close();
  }
});
