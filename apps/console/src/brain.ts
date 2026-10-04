// "Brain" = the model that plans tool calls. The history is Converse-shaped
// ({text}, {toolUse}, {toolResult}) so the agent loop is identical for Claude
// (claude-brain.ts, Bedrock or Anthropic API) and the offline rules brain used
// in tests and when no model credentials are configured.

export type TextBlock = { text: string };
export type ToolUseBlock = { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } };
export type ToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: ({ json: Record<string, unknown> } | { text: string })[];
    status?: 'success' | 'error';
  };
};
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | Record<string, unknown>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BrainResponse {
  content: Block[];
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'other';
  latencyMs: number;
}

export interface Brain {
  readonly kind: 'claude' | 'rules';
  readonly model: string;
  converse(input: { system: string; messages: ChatMessage[]; tools: ToolSpec[] }): Promise<BrainResponse>;
}

export function isToolUse(block: Block): block is ToolUseBlock {
  return typeof block === 'object' && block !== null && 'toolUse' in block;
}

export function isText(block: Block): block is TextBlock {
  return typeof block === 'object' && block !== null && 'text' in block && typeof (block as TextBlock).text === 'string';
}

// ---------------------------------------------------------------------------
// Offline rules brain: deterministic intent rules for demos without AWS
// credentials and for CI. It only ever emits the same tool calls a model
// would, and then speaks the tool's own spoken text.
// ---------------------------------------------------------------------------

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const AFFIRMATIVE = /\b(yes|yeah|yep|yup|confirm|confirmed|go ahead|place (it|them|the orders?)|do it|sure|ok(ay)?|please do)\b/i;
export const NEGATIVE = /\b(no|nope|don't|do not|cancel|stop|wait|never ?mind)\b/i;

/** Questions are never a yes ("Why did the egg order need my OK?"). */
const QUESTION = /\?\s*$|^\s*(why|what|how|when|where|who|which|whose|did|does|do you|can|could|is|are|was|were|should|would|will)\b/i;

export function isAffirmative(text: string): boolean {
  return !QUESTION.test(text) && AFFIRMATIVE.test(text) && !NEGATIVE.test(text);
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = m.content.filter(isText).map((b) => b.text).join(' ');
    if (text) return text;
  }
  return '';
}

function cleanProduct(phrase: string): string {
  return phrase
    .replace(/\b(some|more|a few|a couple of|please|for me|the|a|an|of|now|today|from .*|my usual supplier|usual supplier)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function periodFrom(text: string): string {
  if (/\byesterday\b/i.test(text)) return 'yesterday';
  if (/\blast week\b/i.test(text)) return 'last_week';
  if (/\bthis week\b/i.test(text)) return 'this_week';
  if (/\b(last|past) (7|seven) days\b/i.test(text)) return 'last_7_days';
  if (/\b(last|past) (30|thirty) days|this month\b/i.test(text)) return 'last_30_days';
  return 'today';
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** "Only 8 crates of milk came", "the milk arrived", "nothing came from the bakery" (statements, not questions). */
function planDelivery(t: string): { name: string; input: Record<string, unknown> } | null {
  if (/\?\s*$/.test(t) || /^(did|has|have|is|was|when)\b/.test(t) || /\binvoice\b/.test(t)) return null;
  const nothing = /\bnothing (?:came|arrived|was delivered) from (?:the )?(.+?)[.!]*$/.exec(t);
  if (nothing?.[1]) return { name: 'record_delivery', input: { supplier: nothing[1].trim(), nothing_arrived: true } };
  const partial = /\b(?:only |just )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:(?:crates?|cases?|loaves|loaf|packs?|boxes|box|bags?|cartons?|units?|bottles?|cans?) )?(?:of )?(.+?) (?:came|arrived|were delivered|was delivered|showed up)\b/.exec(t);
  if (partial?.[1] && partial[2]) {
    const qty = /^\d+$/.test(partial[1]) ? Number(partial[1]) : NUMBER_WORDS[partial[1]] ?? 0;
    const product = cleanProduct(partial[2]);
    return { name: 'record_delivery', input: { supplier: product, items: [{ product, received_qty: qty }] } };
  }
  const full = /^(?:all of |everything from )?(?:the )?(.+?) (?:delivery |order )?(?:came|arrived|was delivered|is here)(?: in full| complete)?[.!]*$/.exec(t);
  if (full?.[1] && full[1].split(/\s+/).length <= 4) return { name: 'record_delivery', input: { supplier: cleanProduct(full[1]), everything_arrived: true } };
  return null;
}

/** Maps an utterance to a tool call (name + args) the way a tool-use model would. */
export function planToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  if (isAffirmative(t) && t.split(/\s+/).length <= 6) return { name: 'confirm_reorder', input: { confirmation_token: 'held-by-host' } };
  if (/\b(briefing|morning summary|how('s| is) the shop)\b/.test(t)) return { name: 'get_daily_briefing', input: {} };
  const delivery = planDelivery(t);
  if (delivery) return delivery;
  if (/\bwhy\b/.test(t) && /\b(order|payment|pay|paid|approv|ok|blocked)\w*/.test(t)) {
    const who = /\bwhy (?:did|was|is) (?:the |my )?(.+?) (?:order|payment|bill)\b/.exec(t)?.[1];
    return { name: 'explain_payment', input: who ? { supplier: who.trim() } : {} };
  }
  if (/\b(spending rules|my rules|auto-?pay limit|spending policy|budget rules)\b/.test(t)) return { name: 'get_spending_policy', input: {} };
  if (/\b(spent|spend|spending)\b/.test(t) && /\b(supplier|suppliers|week|today|budget|how much)\b/.test(t)) return { name: 'get_spend_summary', input: {} };
  if (/\b(payment|paid|pay)\b/.test(t) && /\b(status|go through|went through|go out|went out|did|has|is)\b/.test(t)) {
    const who = /\b(?:the|my) (.+?) (?:payment|order)\b/.exec(t)?.[1];
    return { name: 'get_payment_status', input: who ? { supplier: who.trim() } : {} };
  }
  if (/\b(running low|low on|what'?s low|out of stock|low stock)\b/.test(t)) return { name: 'get_low_stock', input: {} };
  if (/\b(invoice|delivery|bill)\b/.test(t)) {
    const m = /(?:the|from)\s+(.+?)\s+(?:invoice|delivery|bill)/.exec(t) ?? /(?:invoice|delivery|bill)\s+from\s+(.+?)(?:\s+(?:arrive|come|get).*)?[?.!]*$/.exec(t);
    const supplier = m?.[1]?.replace(/\b(the|a)\b/g, '').trim();
    return { name: 'get_invoice_status', input: supplier ? { supplier } : {} };
  }
  if (/\b(what should i (re)?order|suggest|need to reorder)\b/.test(t)) return { name: 'suggest_reorder', input: {} };
  const reorder = /\b(?:re-?order|order|restock|buy)\s+(.+?)[?.!]*$/.exec(t);
  if (reorder?.[1]) {
    const items = reorder[1].split(/\s*(?:,|\band\b|&)\s*/).map(cleanProduct).filter((p) => p.length >= 2).map((product) => ({ product }));
    return { name: 'create_reorder_draft', input: items.length > 0 ? { items } : {} };
  }
  if (/\b(top|best|slow(est)?|worst)\b.*\b(sell|seller|product|mover|item)/.test(t)) {
    return { name: 'get_top_movers', input: { period: periodFrom(t) === 'today' && !/\btoday\b/.test(t) ? 'last_7_days' : periodFrom(t), direction: /\b(slow|worst)/.test(t) ? 'bottom' : 'top', metric: /\b(revenue|money|dollars?)\b/.test(t) ? 'revenue' : 'units' } };
  }
  if (/\b(sales|sell|sold|revenue|how did we do|how were we|takings)\b/.test(t)) {
    const input: Record<string, unknown> = { period: periodFrom(t) };
    const weekday = WEEKDAYS.find((d) => new RegExp(`\\b(last|previous)\\s+${d}\\b`).test(t));
    if (weekday) input.compare_weekday = weekday;
    return { name: 'get_sales_summary', input };
  }
  const stock = /\b(?:how many|how much|do we have|stock of|stock level for|left of)\s+(.+?)(?:\s+(?:do we have|left|in stock|are there|is there))?[?.!]*$/.exec(t);
  if (stock?.[1]) {
    const product = cleanProduct(stock[1].replace(/\b(do we have|left|in stock)\b/g, ''));
    if (product.length >= 2) return { name: 'get_stock_level', input: { product } };
  }
  return null;
}

export class RulesBrain implements Brain {
  readonly kind = 'rules' as const;
  readonly model = 'offline-rules-v1';
  private counter = 0;

  async converse(input: { system: string; messages: ChatMessage[]; tools: ToolSpec[] }): Promise<BrainResponse> {
    const started = performance.now();
    const last = input.messages[input.messages.length - 1];
    const results = last?.role === 'user' ? last.content.filter((b): b is ToolResultBlock => typeof b === 'object' && b !== null && 'toolResult' in b) : [];
    if (results.length > 0) {
      // Speak the tools' own spoken text (content[0].text), as instructed for the real model.
      const spoken = results.flatMap((r) => r.toolResult.content.filter((c): c is { text: string } => 'text' in c).map((c) => c.text));
      return { content: [{ text: spoken.join(' ') }], stopReason: 'end_turn', latencyMs: performance.now() - started };
    }
    const text = lastUserText(input.messages);
    if (NEGATIVE.test(text) && !AFFIRMATIVE.test(text)) {
      return { content: [{ text: "Okay, I won't place that order." }], stopReason: 'end_turn', latencyMs: performance.now() - started };
    }
    const plan = planToolCall(text);
    if (!plan || !input.tools.some((t) => t.name === plan.name)) {
      return {
        content: [{ text: 'I can check stock, sales, supplier invoices, and draft reorders. What would you like to know?' }],
        stopReason: 'end_turn',
        latencyMs: performance.now() - started
      };
    }
    this.counter += 1;
    return {
      content: [{ toolUse: { toolUseId: `rules-${this.counter}`, name: plan.name, input: plan.input } }],
      stopReason: 'tool_use',
      latencyMs: performance.now() - started
    };
  }
}
