#!/usr/bin/env node
// End-to-end voice flow: the 5 demo utterances go text -> simulator
// /api/turn -> brain (Bedrock or offline rules) -> MCP server -> spoken reply,
// and the script asserts which MCP tools were called.
//
// Usage:
//   node scripts/demo/e2e_voice_flow.mjs                     # starts local MCP (memory) + sim (rules brain)
//   node scripts/demo/e2e_voice_flow.mjs --sim-url https://sim.example [--access-code X]
//   SIM_BRAIN=bedrock node scripts/demo/e2e_voice_flow.mjs  # local, but with the real Bedrock brain
// Exit code 0 = all assertions passed. Prints a JSON report (use --json-out file).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEMO_UTTERANCES = [
  { text: "What's running low?", expectTools: ['get_low_stock'], expectReply: /running low|low/i },
  { text: 'How were sales today compared to last Friday?', expectTools: ['get_sales_summary'], expectReply: /today/i, expectArgs: { get_sales_summary: { compare_weekday: 'friday' } } },
  { text: 'Reorder milk and eggs', expectTools: ['create_reorder_draft'], expectReply: /draft|confirm/i, expectCard: true },
  { text: 'Yes, confirm', expectTools: ['confirm_reorder'], expectReply: /confirmed|done/i, expectOrder: 'confirmed' },
  { text: 'Did the Sunrise Beverages invoice arrive?', expectTools: ['get_invoice_status'], expectReply: /Sunrise Beverages/i }
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function waitFor(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

export async function startLocalStack() {
  const token = `sv_e2e_${randomBytes(24).toString('base64url')}`;
  const mcpPort = 18190 + Math.floor(Math.random() * 100);
  const simPort = mcpPort + 200;
  const common = { ...process.env, LOG_LEVEL: 'warn', DEMO_ANCHOR_DATE: process.env.DEMO_ANCHOR_DATE ?? '2026-09-25' };
  const mcp = spawn('node', ['apps/mcp-server/dist/server.js'], {
    env: { ...common, MCP_PORT: String(mcpPort), MCP_HOST: '127.0.0.1', MCP_DATA_BACKEND: 'memory', MCP_DEMO_TOKEN: token },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const sim = spawn('node', ['apps/alexa-sim/dist/server.js'], {
    env: { ...common, SIM_PORT: String(simPort), SIM_HOST: '127.0.0.1', SIM_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, SIM_MCP_TOKEN: token, SIM_BRAIN: process.env.SIM_BRAIN ?? 'rules' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitFor(`http://127.0.0.1:${mcpPort}/healthz`);
  await waitFor(`http://127.0.0.1:${simPort}/readyz`);
  return { url: `http://127.0.0.1:${simPort}`, stop: () => { sim.kill('SIGTERM'); mcp.kill('SIGTERM'); } };
}

export async function runVoiceFlow(simUrl, { accessCode } = {}) {
  const headers = { 'content-type': 'application/json', ...(accessCode ? { 'x-sim-access': accessCode } : {}) };
  const config = await (await fetch(`${simUrl}/api/config`, { headers })).json();
  let conversationId;
  const report = { simUrl, brain: config.brain, model: config.model, turns: [], passed: true };
  for (const step of DEMO_UTTERANCES) {
    const started = performance.now();
    const res = await fetch(`${simUrl}/api/turn`, { method: 'POST', headers, body: JSON.stringify({ text: step.text, conversationId }) });
    const data = await res.json();
    conversationId = data.conversationId;
    const tools = (data.toolCalls ?? []).map((c) => c.name);
    const failures = [];
    if (!res.ok) failures.push(`HTTP ${res.status}`);
    for (const t of step.expectTools) if (!tools.includes(t)) failures.push(`expected tool ${t}, got [${tools.join(', ')}]`);
    if (!step.expectReply.test(data.reply ?? '')) failures.push(`reply did not match ${step.expectReply}: ${data.reply}`);
    for (const [tool, expected] of Object.entries(step.expectArgs ?? {})) {
      const call = (data.toolCalls ?? []).find((c) => c.name === tool);
      for (const [k, v] of Object.entries(expected)) if (call?.args?.[k] !== v) failures.push(`${tool}.${k} expected ${v}, got ${call?.args?.[k]}`);
    }
    if (step.expectCard && !data.confirmationCard) failures.push('expected a confirmation card');
    if (step.expectOrder && data.orderResult?.status !== step.expectOrder) failures.push(`expected order ${step.expectOrder}, got ${data.orderResult?.status}`);
    if (JSON.stringify(data).match(/"rc_[A-Za-z0-9_-]{16}"/)) failures.push('confirmation token leaked to the client');
    report.turns.push({
      utterance: step.text,
      tools,
      args: (data.toolCalls ?? []).map((c) => c.args),
      reply: data.reply,
      toolLatencyMs: (data.toolCalls ?? []).map((c) => c.latencyMs),
      turnLatencyMs: Math.round(performance.now() - started),
      brainFallback: data.brainFallback ?? false,
      ok: failures.length === 0,
      failures
    });
    if (failures.length > 0) report.passed = false;
  }
  return report;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const simUrl = arg('--sim-url');
  const stack = simUrl ? null : await startLocalStack();
  try {
    const report = await runVoiceFlow(simUrl ?? stack.url, { accessCode: arg('--access-code') ?? process.env.SIM_ACCESS_CODE });
    const out = arg('--json-out');
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    for (const t of report.turns) {
      console.log(`${t.ok ? 'PASS' : 'FAIL'}  "${t.utterance}" -> [${t.tools.join(', ')}] (${t.turnLatencyMs} ms)`);
      console.log(`      ${t.reply}`);
      for (const f of t.failures) console.log(`      ! ${f}`);
    }
    console.log(`\nbrain=${report.brain} model=${report.model} result=${report.passed ? 'PASSED' : 'FAILED'}`);
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    stack?.stop();
  }
}
