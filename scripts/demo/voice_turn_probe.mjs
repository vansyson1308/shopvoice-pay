#!/usr/bin/env node
// Measures voice-turn round trip against a running console: the time from
// sending the owner's words to receiving the spoken reply (brain + MCP tools,
// no speech synthesis, no PayPal approval). Read-only questions only, so the
// probe never creates orders or moves money. Prints p50/p95/max and the brain
// and model the console reported.
//
// Usage: node scripts/demo/voice_turn_probe.mjs --console-url https://<console> [--rounds 10] [--json-out file]
// The console must run in visitor mode ("Try the demo"); each run gets its own sample shop.
import { writeFileSync } from 'node:fs';
import { percentile } from './latency_probe.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export const QUESTIONS = [
  "What's running low?",
  'How much have I spent on suppliers this week?',
  'What are my spending rules?',
  'How much whole milk do I have?'
];

/** Runs `rounds` passes over the read-only questions; returns per-turn samples. */
export async function probe(consoleUrl, rounds, fetchImpl = fetch) {
  const base = consoleUrl.replace(/\/+$/, '');
  const session = await fetchImpl(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!session.ok) throw new Error(`session failed: ${session.status}`);
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];
  const samples = [];
  let conversationId;
  for (let r = 0; r < rounds; r += 1) {
    for (const text of QUESTIONS) {
      const started = performance.now();
      const res = await fetchImpl(`${base}/api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ text, ...(conversationId ? { conversationId } : {}) })
      });
      const roundTripMs = performance.now() - started;
      const body = await res.json();
      if (!res.ok) throw new Error(`turn failed (${res.status}): ${body.error ?? ''}`);
      conversationId = body.conversationId;
      samples.push({ text, roundTripMs, serverMs: body.totalLatencyMs, brain: body.brain?.kind, model: body.brain?.model, fallback: Boolean(body.brainFallback) });
    }
  }
  return samples;
}

export function summarize(samples) {
  const rt = samples.map((s) => s.roundTripMs);
  return {
    turns: samples.length,
    brain: samples[0]?.brain,
    model: samples[0]?.model,
    fallbacks: samples.filter((s) => s.fallback).length,
    p50_ms: percentile(rt, 50),
    p95_ms: percentile(rt, 95),
    max_ms: percentile(rt, 100),
    under_3s_p50: (percentile(rt, 50) ?? Infinity) < 3000
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = arg('--console-url', 'http://127.0.0.1:8091');
  const rounds = Number(arg('--rounds', '5'));
  const samples = await probe(url, rounds);
  const summary = summarize(samples);
  console.log(JSON.stringify(summary, null, 2));
  const out = arg('--json-out', '');
  if (out) writeFileSync(out, JSON.stringify({ summary, samples }, null, 2));
}
