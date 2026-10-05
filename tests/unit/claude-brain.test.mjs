// Claude brain: Messages API mapping, request shape (model, effort, cache
// breakpoint, tools), thinking blocks sent back unchanged on tool-use turns,
// and the host's guarantees with a model in the loop: the reorder token never
// reaches Claude, and a step-up payment is approved only by a spoken yes that
// console code matched itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ClaudeBrain, claudeClientFromEnv, toClaudeMessages, fromClaudeContent, resolveVoiceModel, bedrockEndpointFor, DEFAULT_BEDROCK_MODEL } from '../../apps/console/dist/claude-brain.js';
import { runTurn, newConversation, approvalAnswer } from '../../apps/console/dist/agent.js';
import { McpToolbox } from '../../apps/console/dist/toolbox.js';
import { RulesBrain } from '../../apps/console/dist/brain.js';
import { BrowserSpeech } from '../../apps/console/dist/speech.js';
import { createSimHandler, loadSimConfig } from '../../apps/console/dist/server.js';
import { MemoryShopStore } from '../../apps/mcp-server/dist/memory-store.js';
import { startMcpServer, twoTenantDataset, mockPayments, silentLogger, TOKEN_A, ANCHOR } from './mcp-harness.mjs';

const clock = () => Date.parse(`${ANCHOR}T15:00:00Z`);
const CONFIG = { provider: 'bedrock', model: DEFAULT_BEDROCK_MODEL, family: 'sonnet', effort: 'low', maxTokens: 4096 };

/** Replays scripted Messages API responses and records every request. */
function stubClient(script) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(params) {
        requests.push(structuredClone(params));
        const next = script.shift();
        if (!next) throw new Error('stub: no more responses');
        return typeof next === 'function' ? next(params) : next;
      }
    }
  };
}

const msg = (content, stop_reason) => ({ id: 'msg', type: 'message', role: 'assistant', model: DEFAULT_BEDROCK_MODEL, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
const THINKING = { type: 'thinking', thinking: '', signature: 'sig-abc-123' };

test('history mapping: text, tool use, tool results (json + error), thinking passes through', () => {
  const out = toClaudeMessages([
    { role: 'user', content: [{ text: 'Reorder milk' }] },
    { role: 'assistant', content: [THINKING, { toolUse: { toolUseId: 't1', name: 'create_reorder_draft', input: { items: [{ product: 'milk' }] } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: 'Draft ready.' }, { json: { status: 'draft_created' } }] } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 't2', status: 'error', content: [{ text: 'blocked' }] } }] }
  ]);
  assert.deepEqual(out[0], { role: 'user', content: [{ type: 'text', text: 'Reorder milk' }] });
  assert.deepEqual(out[1].content[0], THINKING, 'thinking block unchanged');
  assert.deepEqual(out[1].content[1], { type: 'tool_use', id: 't1', name: 'create_reorder_draft', input: { items: [{ product: 'milk' }] } });
  assert.deepEqual(out[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Draft ready.' }, { type: 'text', text: '{"status":"draft_created"}' }] });
  assert.equal(out[3].content[0].is_error, true);
  assert.deepEqual(fromClaudeContent([THINKING, { type: 'text', text: 'Hi', citations: null }, { type: 'tool_use', id: 'x', name: 'get_low_stock', input: {} }]), [
    THINKING, { text: 'Hi' }, { toolUse: { toolUseId: 'x', name: 'get_low_stock', input: {} } }
  ]);
});

test('request shape: Sonnet 5.5 on Bedrock, low effort, adaptive thinking, one cache breakpoint on system, tools as input_schema', async () => {
  const client = stubClient([msg([{ type: 'text', text: 'Hello.' }], 'end_turn')]);
  const brain = new ClaudeBrain(client, CONFIG);
  const r = await brain.converse({ system: 'SYS', messages: [{ role: 'user', content: [{ text: 'hi' }] }], tools: [{ name: 'get_low_stock', description: 'Low stock', inputSchema: { type: 'object', properties: {} } }] });
  assert.equal(r.stopReason, 'end_turn');
  const p = client.requests[0];
  assert.equal(p.model, 'anthropic.claude-sonnet-5-5');
  assert.deepEqual(p.output_config, { effort: 'low' });
  assert.equal(p.thinking, undefined, 'adaptive thinking is the default; disabled would be a 400 on Sonnet 5.5');
  assert.equal(p.tool_choice, undefined, 'forced tool_choice is a 400 on Sonnet 5.5');
  assert.deepEqual(p.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(p.tools, [{ name: 'get_low_stock', description: 'Low stock', input_schema: { type: 'object', properties: {} } }]);
  assert.equal(brain.kind, 'claude');
});

test('client from env: Sonnet 5.5 by default, Haiku 4.5 as the fast option, Opus refused; Bedrock credentials separate', () => {
  assert.throws(() => claudeClientFromEnv({ BRAIN: 'claude-bedrock' }), /BEDROCK_AWS_ACCESS_KEY_ID/);
  assert.throws(() => claudeClientFromEnv({ BRAIN: 'claude-api' }), /ANTHROPIC_API_KEY/);
  const keys = { BEDROCK_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', BEDROCK_AWS_SECRET_ACCESS_KEY: 'secret' };

  const bedrock = claudeClientFromEnv({ BRAIN: 'claude-bedrock', ...keys, CLAUDE_EFFORT: 'medium' });
  assert.deepEqual(bedrock.config, { provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5', family: 'sonnet', effort: 'medium', maxTokens: 4096 });
  assert.equal(bedrock.client.constructor.name, 'AnthropicBedrockMantle');

  const fast = claudeClientFromEnv({ BRAIN: 'claude-bedrock', ...keys, CLAUDE_MODEL: 'haiku' });
  assert.equal(fast.config.model, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(fast.config.family, 'haiku');
  assert.equal(fast.client.constructor.name, 'AnthropicBedrock', 'Haiku 4.5 is on the Bedrock runtime, not Mantle');

  const api = claudeClientFromEnv({ BRAIN: 'claude-api', ANTHROPIC_API_KEY: 'sk-test' });
  assert.equal(api.config.model, 'claude-sonnet-5-5');
  assert.equal(claudeClientFromEnv({ BRAIN: 'claude-api', ANTHROPIC_API_KEY: 'sk-test', CLAUDE_MODEL: 'haiku' }).config.model, 'claude-haiku-4-5-20251001');

  for (const slow of ['claude-opus-5-5', 'anthropic.claude-opus-5-5', 'opus', 'claude-fable-5-1']) {
    assert.throws(() => claudeClientFromEnv({ BRAIN: 'claude-bedrock', ...keys, CLAUDE_MODEL: slow }), /not a voice model/, slow);
  }
  assert.throws(() => claudeClientFromEnv({ BRAIN: 'claude-bedrock', ...keys, CLAUDE_MODEL: 'claude-sonnet-5-5' }), /contain "anthropic\."/);
  assert.throws(() => claudeClientFromEnv({ BRAIN: 'claude-api', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'anthropic.claude-sonnet-5-5' }), /Bedrock id/);
  assert.deepEqual(resolveVoiceModel('bedrock', 'global.anthropic.claude-sonnet-5-5'), { model: 'global.anthropic.claude-sonnet-5-5', family: 'sonnet' });
  assert.equal(bedrockEndpointFor('anthropic.claude-sonnet-5-5'), 'mantle');
  assert.equal(bedrockEndpointFor('global.anthropic.claude-sonnet-5-5'), 'runtime');
  assert.equal(bedrockEndpointFor('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'runtime');
});

test('Haiku 4.5 requests carry no effort setting (the model has none)', async () => {
  const client = stubClient([msg([{ type: 'text', text: 'Hi.' }], 'end_turn')]);
  const brain = new ClaudeBrain(client, { ...CONFIG, model: 'claude-haiku-4-5-20251001', family: 'haiku', provider: 'anthropic' });
  await brain.converse({ system: 'SYS', messages: [{ role: 'user', content: [{ text: 'hi' }] }], tools: [] });
  assert.equal(client.requests[0].output_config, undefined);
  assert.equal(client.requests[0].thinking, undefined);
  assert.equal(client.requests[0].model, 'claude-haiku-4-5-20251001');
});


test('agent with Claude: thinking goes back unchanged, the reorder token never reaches Claude, confirm needs a spoken yes', async () => {
  const mcp = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments: mockPayments(clock) });
  const toolbox = new McpToolbox(`${mcp.url}/mcp`, TOKEN_A);
  const client = stubClient([
    msg([THINKING, { type: 'tool_use', id: 'u1', name: 'create_reorder_draft', input: { items: [{ product: 'milk' }, { product: 'eggs' }] } }], 'tool_use'),
    msg([{ type: 'text', text: 'Drafted two orders, about $226. Say confirm to place them.' }], 'end_turn'),
    // Claude tries to confirm on its own with a made-up token, on a turn where the owner did not say yes.
    msg([{ type: 'tool_use', id: 'u2', name: 'confirm_reorder', input: { confirmation_token: 'rc_made_up_by_model' } }], 'tool_use'),
    msg([{ type: 'text', text: 'Please confirm first.' }], 'end_turn'),
    msg([{ type: 'tool_use', id: 'u3', name: 'confirm_reorder', input: { confirmation_token: 'whatever' } }], 'tool_use'),
    msg([{ type: 'text', text: 'Done.' }], 'end_turn')
  ]);
  const brain = new ClaudeBrain(client, CONFIG);
  const conversation = newConversation('c', Date.now());
  const base = { conversation, brain, toolbox, today: ANCHOR, now: Date.now };
  try {
    await runTurn({ ...base, userText: 'Reorder milk and eggs' });
    const token = conversation.pending.token;
    assert.match(token, /^rc_/);
    assert.deepEqual(client.requests[1].messages[1].content[0], THINKING, 'thinking block sent back unchanged on the tool-use turn');

    const eager = await runTurn({ ...base, userText: 'What will that cost?' });
    assert.ok(eager.toolCalls[0].blockedByHost, 'the host refuses confirm without a spoken yes');
    assert.equal(eager.orderResult, null);

    const yes = await runTurn({ ...base, userText: 'Yes, confirm' });
    assert.equal(yes.orderResult.status, 'confirmed');
    for (const req of client.requests) assert.ok(!JSON.stringify(req).includes(token), 'the reorder token never reaches Claude');
  } finally {
    await toolbox.close();
    await mcp.close();
  }
});

test('approval answers are matched by code: short yes/no only', () => {
  for (const t of ['yes', 'Yes, approve it', 'approve it', 'sure', 'go ahead']) assert.equal(approvalAnswer(t), 'yes', t);
  for (const t of ['no', "no, don't", 'cancel it', 'not now, wait']) assert.equal(approvalAnswer(t), 'no', t);
  for (const t of ['what does it cost?', 'yes but first tell me how much milk we have left in the back room today', 'Why did the egg order need my OK?', 'approve it?']) assert.equal(approvalAnswer(t), null, t);
});

async function consoleStack() {
  const payments = mockPayments(clock);
  const mcp = await startMcpServer({ store: new MemoryShopStore(twoTenantDataset(), clock), payments });
  const config = loadSimConfig({ SIM_MCP_URL: `${mcp.url}/mcp`, SIM_MCP_TOKEN: TOKEN_A, DEMO_ANCHOR_DATE: ANCHOR });
  const toolbox = new McpToolbox(config.mcpUrl, TOKEN_A);
  const handler = createSimHandler({ config, logger: silentLogger, toolbox, brain: new RulesBrain(), fallbackBrain: new RulesBrain(), speech: new BrowserSpeech(), staticDir: fileURLToPath(new URL('../../apps/console/static/', import.meta.url)) });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let conversationId;
  const say = async (text) => {
    const res = await fetch(`${url}/api/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, conversationId }) });
    const json = await res.json();
    conversationId = json.conversationId;
    return json;
  };
  const ledger = async () => (await (await fetch(`${url}/api/owner/ledger`)).json()).payments;
  return { say, ledger, async close() { await toolbox.close(); await new Promise((r) => server.close(r)); await mcp.close(); } };
}

test('voice: after confirm the host asks; "yes" approves through the owner API (owner_voice), not the model', async () => {
  const s = await consoleStack();
  try {
    await s.say('Reorder milk and eggs');
    const confirmed = await s.say('Yes, confirm');
    assert.match(confirmed.reply, /Say "yes" to approve \$142 to Valley Farm Eggs, or "no" to leave it unpaid\.$/);
    const approved = await s.say('Yes, approve it');
    assert.equal(approved.brain.kind, 'host', 'no model call');
    assert.equal(approved.toolCalls[0].name, 'approve_payment');
    assert.equal(approved.approvalResult.decision, 'approved');
    assert.match(approved.reply, /^Approved\. \$142 to Valley Farm Eggs is held/);
    const eggs = (await s.ledger()).find((p) => p.supplier_code === 'SUP-EGGS' && p.created_by === 'agent');
    assert.equal(eggs.status, 'authorized');
    assert.equal(eggs.approved_by, 'owner_voice');
    const again = await s.say('yes');
    assert.notEqual(again.brain.kind, 'host', 'the question is answered once; a later yes is an ordinary turn');
  } finally {
    await s.close();
  }
});

test('voice: "no" leaves it unpaid; any other request drops the question so a later yes approves nothing', async () => {
  const s = await consoleStack();
  try {
    await s.say('Reorder milk and eggs');
    await s.say('Yes, confirm');
    const declined = await s.say('No');
    assert.equal(declined.approvalResult.decision, 'declined');
    assert.match(declined.reply, /left the Valley Farm Eggs order unpaid/);
    assert.equal((await s.ledger()).find((p) => p.supplier_code === 'SUP-EGGS' && p.created_by === 'agent').status, 'voided');

    await s.say('Reorder eggs');
    await s.say('Yes, confirm');
    await s.say("What's running low?");
    const later = await s.say('yes');
    assert.equal(later.approvalResult, null);
    const waiting = (await s.ledger()).filter((p) => p.status === 'pending_approval');
    assert.equal(waiting.length, 1, 'still waiting on the console card');
  } finally {
    await s.close();
  }
});
