// One voice turn: user text -> brain (Bedrock Converse tool use) -> MCP tool
// calls -> spoken reply. The host (not the model) enforces the reorder safety
// rules: confirmation tokens never enter the model context, and
// confirm_reorder only runs when the owner said yes in this very turn.
import type { Block, Brain, ChatMessage, ToolResultBlock, ToolSpec } from './brain.js';
import { isAffirmative, isText, isToolUse } from './brain.js';
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

export interface Conversation {
  readonly id: string;
  messages: ChatMessage[];
  pending: PendingConfirmation | null;
  lastSeenMs: number;
}

export interface TurnResult {
  readonly reply: string;
  readonly toolCalls: ToolTrace[];
  readonly confirmationCard: Record<string, unknown> | null;
  readonly orderResult: Record<string, unknown> | null;
  readonly brain: { kind: string; model: string; latencyMs: number; rounds: number };
  readonly totalLatencyMs: number;
}

export function systemPrompt(today: string): string {
  return [
    'You are the voice assistant of a small grocery shop (an Alexa+ style assistant). The shop owner is busy; answers are spoken aloud.',
    `Today is ${today}.`,
    'Always use the ShopVoice tools for shop data; never guess numbers.',
    'Each tool result has a "text" part written to be spoken. Reply with that text, lightly adapted, in at most 35 words. No lists, markdown or emojis.',
    'Reorders are two-step: call create_reorder_draft, speak its summary, and wait. Only when the owner clearly says yes, call confirm_reorder (the host fills in the confirmation token). If they say no, do nothing.',
    'For "compared to last <weekday>" use get_sales_summary with compare_weekday. If a tool asks a clarifying question, ask it.'
  ].join(' ');
}

export function newConversation(id: string, now: number): Conversation {
  return { id, messages: [], pending: null, lastSeenMs: now };
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
}): Promise<TurnResult> {
  const started = performance.now();
  const { conversation, brain, toolbox } = opts;
  const userText = opts.userText.trim().slice(0, 500);
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
      }

      if (blocked) {
        traces.push({ name, args: { ...args, confirmation_token: '[held by host]' }, latencyMs: 0, isError: true, spoken: blocked, structured: null, blockedByHost: blocked });
        results.push({ toolResult: { toolUseId, status: 'error', content: [{ text: blocked }] } } satisfies ToolResultBlock);
        continue;
      }

      const result = await toolbox.callTool(name, args);
      const structured = result.structured;
      const shownArgs = name === 'confirm_reorder' ? { confirmation_token: '[held by host]' } : args;
      traces.push({ name, args: shownArgs, latencyMs: Math.round(result.latencyMs), isError: result.isError, spoken: result.spoken, structured: redactStructured(structured) });

      if (name === 'create_reorder_draft' && structured?.status === 'draft_created' && typeof structured.confirmation_token === 'string') {
        conversation.pending = { token: structured.confirmation_token, expiresAt: String(structured.expires_at ?? ''), summary: redactStructured(structured) ?? {} };
        confirmationCard = redactStructured(structured);
      }
      if (name === 'confirm_reorder' && structured) {
        orderResult = structured;
        if (structured.status !== 'expired') conversation.pending = null;
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
  conversation.messages = trimHistory(conversation.messages);
  conversation.lastSeenMs = opts.now();

  return {
    reply,
    toolCalls: traces,
    confirmationCard,
    orderResult,
    brain: { kind: brain.kind, model: brain.model, latencyMs: Math.round(brainLatency), rounds: rounds + 1 },
    totalLatencyMs: Math.round(performance.now() - started)
  };
}
