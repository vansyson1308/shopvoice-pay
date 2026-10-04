// One voice turn: user text -> brain (Bedrock Converse tool use) -> MCP tool
// calls -> spoken reply. The host (not the model) enforces the reorder safety
// rules: confirmation tokens never enter the model context, and
// confirm_reorder only runs when the owner said yes in this very turn.
import type { Block, Brain, ChatMessage, ToolResultBlock, ToolSpec } from './brain.js';
import { isAffirmative, isText, isToolUse, NEGATIVE, AFFIRMATIVE } from './brain.js';
import type { Toolbox } from './toolbox.js';

export const MAX_TOOL_ROUNDS = 4;
const HISTORY_LIMIT = 16;

export interface ToolTrace {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly spoken: string;
  readonly structured: Record<string, unknown> | null;
  readonly blockedByHost?: string;
}

export interface PendingConfirmation {
  readonly token: string;
  readonly expiresAt: string;
  readonly summary: Record<string, unknown>;
}

/** A payment the host just asked the owner about by voice; only the very next turn can answer it. */
export interface AwaitingApproval {
  readonly paymentId: string;
  readonly supplierName: string;
  readonly amount: string;
}

export interface Conversation {
  readonly id: string;
  messages: ChatMessage[];
  pending: PendingConfirmation | null;
  /** A refund confirmation token, held by the host like the reorder token. */
  pendingRefund: string | null;
  awaitingApproval: AwaitingApproval | null;
  lastSeenMs: number;
}

/**
 * The owner's approval channel for the console (owner API, the console's own
 * credential). Called only by host code after a spoken yes/no it matched
 * itself, never by the model.
 */
export interface VoiceApprover {
  approve(paymentId: string): Promise<{ ok: boolean; speech: string; payment: Record<string, unknown> | null }>;
  decline(paymentId: string): Promise<{ ok: boolean; speech: string; payment: Record<string, unknown> | null }>;
}

export interface TurnResult {
  readonly reply: string;
  readonly toolCalls: ToolTrace[];
  readonly confirmationCard: Record<string, unknown> | null;
  readonly orderResult: Record<string, unknown> | null;
  /** Set when the host approved or declined a payment from a spoken yes/no. */
  readonly approvalResult: { readonly decision: 'approved' | 'declined'; readonly ok: boolean; readonly payment: Record<string, unknown> | null } | null;
  readonly brain: { kind: string; model: string; latencyMs: number; rounds: number };
  readonly totalLatencyMs: number;
}

export function systemPrompt(today: string): string {
  return [
    'You are the voice assistant of a small grocery shop. The shop owner is busy; answers are spoken aloud.',
    `Today is ${today}.`,
    'Always use the ShopVoice tools for shop data; never guess numbers.',
    'Each tool result has a "text" part written to be spoken. Reply with that text, lightly adapted, in at most 35 words. No lists, markdown or emojis.',
    'Reorders are two-step: call create_reorder_draft, speak its summary, and wait. Only when the owner clearly says yes, call confirm_reorder (the host fills in the confirmation token). If they say no, do nothing.',
    "confirm_reorder pays suppliers through PayPal within the owner's spending rules; you cannot approve payments: when one waits for approval, the host asks the owner itself.",
    'When the owner says what was delivered (for example "only 8 crates of milk came"), call record_delivery. For refunds, rule changes, payment status, spend or "why", use the matching tool.',
    'For "compared to last <weekday>" use get_sales_summary with compare_weekday. If a tool asks a clarifying question, ask it.'
  ].join(' ');
}

export function newConversation(id: string, now: number): Conversation {
  return { id, messages: [], pending: null, pendingRefund: null, awaitingApproval: null, lastSeenMs: now };
}

/**
 * Tools that change money or rules run only when the owner's own words in
 * this turn ask for it; a model acting on its own (or on injected text) is
 * refused by the host. confirm_reorder and refund confirmations need a yes.
 */
export const OWNER_INTENT: Readonly<Record<string, { readonly pattern: RegExp; readonly refusal: string }>> = {
  record_delivery: { pattern: /\b(arriv|came|come|deliver|got|showed|received|nothing|short|missing|only)\w*/i, refusal: 'The owner did not report a delivery in this turn. Ask what arrived.' },
  request_refund: { pattern: /\b(refund|money back|credit|return|stale|spoil|damaged|wrong)\w*/i, refusal: 'The owner did not ask for a refund in this turn.' },
  set_spending_policy: { pattern: /\b(limit|budget|cap|rule|polic|approve|approved|supplier|allow|threshold|auto-?pay|spend)\w*/i, refusal: 'The owner did not ask to change the spending rules in this turn.' }
};

/** A plain spoken answer to the host's approval question; anything else is a new request. */
export function approvalAnswer(text: string): 'yes' | 'no' | null {
  const t = text.trim();
  if (t.split(/\s+/).length > 8) return null;
  if (/\?\s*$/.test(t)) return null;
  if (isAffirmative(t) || (/^\s*approve( it)?\b/i.test(t) && !NEGATIVE.test(t))) return 'yes';
  if (NEGATIVE.test(t) && !AFFIRMATIVE.test(t)) return 'no';
  return null;
}

function waitingInConsole(structured: Record<string, unknown> | null): AwaitingApproval | null {
  const payments = Array.isArray(structured?.payments) ? (structured?.payments as Record<string, unknown>[]) : [];
  const waiting = payments.find((p) => (p.approval as Record<string, unknown> | undefined)?.state === 'waiting_in_console');
  if (!waiting || typeof waiting.payment_id !== 'string') return null;
  const amount = typeof waiting.amount === 'number' ? `$${waiting.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'the order';
  return { paymentId: waiting.payment_id, supplierName: String(waiting.supplier_name ?? 'the supplier'), amount };
}

/** Trim history at user-text boundaries so toolUse/toolResult pairs stay intact. */
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HISTORY_LIMIT) return messages;
  for (let i = messages.length - HISTORY_LIMIT; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role === 'user' && m.content.some(isText)) return messages.slice(i);
  }
  return messages.slice(-2);
}

function redactStructured(structured: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!structured) return null;
  if ('confirmation_token' in structured) {
    return { ...structured, confirmation_token: structured.confirmation_token ? '[held by host]' : null };
  }
  return structured;
}

export async function runTurn(opts: {
  readonly conversation: Conversation;
  readonly userText: string;
  readonly brain: Brain;
  readonly toolbox: Toolbox;
  readonly today: string;
  readonly now: () => number;
  readonly approver?: VoiceApprover;
}): Promise<TurnResult> {
  const started = performance.now();
  const { conversation, brain, toolbox } = opts;
  const userText = opts.userText.trim().slice(0, 500);

  // Step-up approval by voice: decided here, by host code, from the owner's own words.
  const awaiting = conversation.awaitingApproval;
  conversation.awaitingApproval = null;
  const answer = awaiting && opts.approver ? approvalAnswer(userText) : null;
  if (awaiting && opts.approver && answer) {
    const outcome = answer === 'yes' ? await opts.approver.approve(awaiting.paymentId) : await opts.approver.decline(awaiting.paymentId);
    conversation.messages.push({ role: 'user', content: [{ text: userText }] });
    conversation.messages.push({ role: 'assistant', content: [{ text: outcome.speech }] });
    conversation.messages = trimHistory(conversation.messages);
    conversation.lastSeenMs = opts.now();
    const name = answer === 'yes' ? 'approve_payment' : 'decline_payment';
    return {
      reply: outcome.speech,
      toolCalls: [{ name, args: { payment_id: awaiting.paymentId }, latencyMs: 0, isError: !outcome.ok, spoken: outcome.speech, structured: outcome.payment, blockedByHost: 'Owner API (host): the spoken answer was matched by console code, not the model.' }],
      confirmationCard: null,
      orderResult: null,
      approvalResult: { decision: answer === 'yes' ? 'approved' : 'declined', ok: outcome.ok, payment: outcome.payment },
      brain: { kind: 'host', model: 'none', latencyMs: 0, rounds: 0 },
      totalLatencyMs: Math.round(performance.now() - started)
    };
  }
  const affirmed = isAffirmative(userText);
  const tools: ToolSpec[] = await toolbox.listTools();
  const traces: ToolTrace[] = [];
  let confirmationCard: Record<string, unknown> | null = null;
  let orderResult: Record<string, unknown> | null = null;
  let brainLatency = 0;
  let rounds = 0;
  let reply = '';

  conversation.messages.push({ role: 'user', content: [{ text: userText }] });

  for (; rounds < MAX_TOOL_ROUNDS; rounds += 1) {
    const response = await brain.converse({ system: systemPrompt(opts.today), messages: conversation.messages, tools });
    brainLatency += response.latencyMs;
    conversation.messages.push({ role: 'assistant', content: response.content });
    const toolUses = response.content.filter(isToolUse);
    if (response.stopReason !== 'tool_use' || toolUses.length === 0) {
      reply = response.content.filter(isText).map((b) => b.text).join(' ').trim();
      break;
    }

    const results: Block[] = [];
    for (const use of toolUses) {
      const { toolUseId, name } = use.toolUse;
      const args = { ...(use.toolUse.input ?? {}) };
      let blocked: string | undefined;

      if (name === 'confirm_reorder') {
        if (!affirmed) blocked = 'The owner has not said yes in this turn. Ask them to confirm first.';
        else if (!conversation.pending) blocked = 'There is no pending reorder draft to confirm.';
        else args.confirmation_token = conversation.pending.token;
      } else if (name === 'request_refund' && args.confirmation_token !== undefined) {
        if (!affirmed) blocked = 'The owner has not said yes in this turn. Ask them to confirm the refund first.';
        else if (!conversation.pendingRefund) blocked = 'There is no pending refund to confirm.';
        else args.confirmation_token = conversation.pendingRefund;
      } else if (OWNER_INTENT[name] && !OWNER_INTENT[name]?.pattern.test(userText)) {
        blocked = OWNER_INTENT[name]?.refusal;
      }

      if (blocked) {
        traces.push({ name, args: 'confirmation_token' in args ? { ...args, confirmation_token: '[held by host]' } : args, latencyMs: 0, isError: true, spoken: blocked, structured: null, blockedByHost: blocked });
        results.push({ toolResult: { toolUseId, status: 'error', content: [{ text: blocked }] } } satisfies ToolResultBlock);
        continue;
      }

      const result = await toolbox.callTool(name, args);
      const structured = result.structured;
      const shownArgs = name === 'confirm_reorder' ? { confirmation_token: '[held by host]' } : 'confirmation_token' in args ? { ...args, confirmation_token: '[held by host]' } : args;
      traces.push({ name, args: shownArgs, latencyMs: Math.round(result.latencyMs), isError: result.isError, spoken: result.spoken, structured: redactStructured(structured) });

      if (name === 'create_reorder_draft' && structured?.status === 'draft_created' && typeof structured.confirmation_token === 'string') {
        conversation.pending = { token: structured.confirmation_token, expiresAt: String(structured.expires_at ?? ''), summary: redactStructured(structured) ?? {} };
        conversation.awaitingApproval = null;
        confirmationCard = redactStructured(structured);
      }
      if (name === 'request_refund' && structured) {
        conversation.pendingRefund = structured.status === 'needs_confirmation' && typeof structured.confirmation_token === 'string' ? structured.confirmation_token : null;
      }
      if (name === 'confirm_reorder' && structured) {
        orderResult = structured;
        if (structured.status !== 'expired') conversation.pending = null;
        conversation.awaitingApproval = opts.approver ? waitingInConsole(structured) : null;
      }

      const content: ({ json: Record<string, unknown> } | { text: string })[] = [{ text: result.spoken }];
      const forModel = redactStructured(structured);
      if (forModel) content.push({ json: forModel });
      results.push({ toolResult: { toolUseId, status: result.isError ? 'error' : 'success', content } } satisfies ToolResultBlock);
    }
    conversation.messages.push({ role: 'user', content: results });
  }

  if (!reply) {
    // Out of tool rounds: fall back to the last tool's own spoken text.
    reply = traces[traces.length - 1]?.spoken ?? "Sorry, I didn't catch that.";
  }
  if (!/[.?!]$/.test(reply)) reply = `${reply}.`;
  const ask = conversation.awaitingApproval;
  if (ask) reply = `${reply} Say "yes" to approve ${ask.amount} to ${ask.supplierName}, or "no" to leave it unpaid.`;
  conversation.messages = trimHistory(conversation.messages);
  conversation.lastSeenMs = opts.now();

  return {
    reply,
    toolCalls: traces,
    confirmationCard,
    orderResult,
    approvalResult: null,
    brain: { kind: brain.kind, model: brain.model, latencyMs: Math.round(brainLatency), rounds: rounds + 1 },
    totalLatencyMs: Math.round(performance.now() - started)
  };
}
