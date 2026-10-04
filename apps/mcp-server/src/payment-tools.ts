// ShopVoice Pay tools: confirming a reorder pays each supplier within the
// owner's spending rules, plus status, delivery, refund and policy tools.
//
// Safety contract (DECISIONS.md D2, D10):
//  * The model can only propose. PaymentsService and the policy engine decide
//    and move money; tools pass them data the server loaded itself.
//  * Tool output never carries an approval token, a vault id or a PayPal
//    authorization/capture id. Payment ids here are ShopVoice ledger ids.
//  * A step-up is approved outside the model: by the owner's console, by the
//    MCP client's own confirmation form (elicitation), or on PayPal's page.
//    If none of those can reach the owner, the payment is declined.
import { z } from 'zod';
import type { DraftRow, ShopRepository } from './store.js';
import { defineTool, READ_ONLY, moneyOut, hashConfirmationToken, supplierMatches } from './tools.js';
import type { ToolContext, PaymentsBridge } from './tools.js';
import { countWord, fitSpeech, formatMoney, joinList, minorToDisplay, speakList } from './speech.js';
import { describeDate } from './analytics.js';
import { PaymentFlowError, describeStatus } from './payments/service.js';
import type { PayResult, PublicPayment } from './payments/service.js';
import type { PolicyReason, SpendPolicy } from './policy/policy-engine.js';
import { LedgerError } from './ledger/state-machine.js';
import { PayPalApiError, PayPalTransportError } from './payments/paypal-client.js';

function isPayPalError(error: unknown): boolean {
  return error instanceof PayPalApiError || error instanceof PayPalTransportError;
}

const SESSION_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const NOT_SET_UP = 'Payments are not set up for this shop yet, so I cannot do that.';

// ---------- shared helpers ----------

async function supplierNames(repo: ShopRepository): Promise<Map<string, string>> {
  return new Map((await repo.listSuppliers()).map((s) => [s.code, s.name]));
}

function nameOf(names: Map<string, string>, code: string): string {
  return names.get(code) ?? code;
}

/** The reason worth saying out loud first: blocks, then price and quantity surprises, then limits. */
const REASON_PRIORITY = ['not_allow_listed', 'no_payee', 'payee_unverified', 'duplicate_order', 'over_daily_hard_cap', 'over_weekly_hard_cap',
  'invalid_amount', 'currency_mismatch', 'total_mismatch', 'price_jump', 'quantity_spike', 'over_per_order_limit', 'over_daily_budget',
  'over_weekly_budget', 'first_order_with_supplier', 'no_payment_method'];

export function headlineReason(reasons: readonly PolicyReason[]): PolicyReason | null {
  const relevant = reasons.filter((r) => r.effect !== 'info');
  return [...relevant].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function rank(r: PolicyReason): number {
  const i = REASON_PRIORITY.indexOf(r.code);
  return i === -1 ? REASON_PRIORITY.length : i;
}

export function shortReason(r: PolicyReason): string {
  switch (r.code) {
    case 'price_jump': return `${r.text.split(' went up')[0] ?? 'the price'} is up ${r.detail?.change_pct ?? 'sharply'}%`;
    case 'quantity_spike': return 'the quantity is unusually large';
    case 'over_per_order_limit': return "it's over your auto-pay limit";
    case 'over_daily_budget': return "it's over today's budget";
    case 'over_weekly_budget': return "it's over this week's budget";
    case 'first_order_with_supplier': return "it's your first order with them";
    case 'no_payment_method': return "PayPal isn't connected";
    case 'not_allow_listed': return "they're not on your approved list";
    case 'no_payee': return 'they have no PayPal account on file';
    case 'payee_unverified': return "their PayPal account isn't verified";
    case 'duplicate_order': return 'the same order went out in the last day';
    case 'over_daily_hard_cap': return "it's over your daily hard cap";
    case 'over_weekly_hard_cap': return "it's over your weekly hard cap";
    default: return r.text.replace(/\.$/, '');
  }
}

const paymentSchema = z.object({
  payment_id: z.string(),
  supplier_code: z.string(),
  supplier_name: z.string(),
  status: z.enum(['pending_approval', 'authorized', 'partially_captured', 'captured', 'voided', 'refunded', 'failed', 'blocked']),
  status_text: z.string(),
  decision: z.enum(['autopay', 'step_up', 'blocked']),
  amount_minor: z.number().int(),
  amount: z.number(),
  held_minor: z.number().int(),
  held: z.number(),
  charged_minor: z.number().int(),
  charged: z.number(),
  released_minor: z.number().int(),
  refunded_minor: z.number().int(),
  approved_by: z.string().nullable(),
  reasons: z.array(z.string()),
  created_at: z.string(),
  honor_period_ends_at: z.string().nullable().describe('PayPal honors the hold in full until this time (3 days); the hold is renewed at delivery if needed, never earlier.'),
  hold_expires_at: z.string().nullable().describe('The hold lapses at this time (29 days after it was placed).')
});
type PaymentOut = z.infer<typeof paymentSchema>;

function paymentOut(ctx: ToolContext, p: PublicPayment, names: Map<string, string>): PaymentOut {
  return {
    payment_id: p.paymentId,
    supplier_code: p.supplierCode,
    supplier_name: nameOf(names, p.supplierCode),
    status: p.status,
    status_text: describeStatus(p),
    decision: p.decision,
    amount_minor: p.requestedMinor,
    amount: minorToDisplay(p.requestedMinor, ctx.money),
    held_minor: p.heldMinor,
    held: minorToDisplay(p.heldMinor, ctx.money),
    charged_minor: p.chargedMinor,
    charged: minorToDisplay(p.chargedMinor, ctx.money),
    released_minor: p.releasedMinor,
    refunded_minor: p.refundedMinor,
    approved_by: p.approvedBy,
    reasons: [...p.reasons],
    created_at: p.createdAt,
    honor_period_ends_at: p.honorPeriodEndsAt,
    hold_expires_at: p.holdExpiresAt
  };
}

function dayOf(iso: string | null, ctx: ToolContext): string | null {
  if (!iso) return null;
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  return describeDate(local, ctx.today);
}

/** Picks a payment by ledger id, or the latest one for a supplier that passes `accept`. */
async function findPayment(bridge: PaymentsBridge, names: Map<string, string>, args: { payment_id?: string | undefined; supplier?: string | undefined }, accept: (p: PublicPayment) => boolean): Promise<PublicPayment | null> {
  const recent = await bridge.service.listPublicPayments(bridge.ctx, 200);
  const candidates = recent.filter((p) => {
    if (args.payment_id) return p.paymentId === args.payment_id;
    if (args.supplier) return supplierMatches({ supplierCode: p.supplierCode, supplierName: nameOf(names, p.supplierCode) }, args.supplier);
    return true;
  });
  return candidates.find(accept) ?? null;
}

const lookupInput = {
  payment_id: z.string().uuid().optional().describe('ShopVoice payment id from an earlier tool result.'),
  supplier: z.string().trim().min(2).max(80).optional().describe('Supplier name, e.g. "Valley Farm Eggs" or "the dairy".')
};

// ---------- confirm_reorder: confirm drafts, then pay within the rules ----------

const approvalSchema = z.object({
  state: z.enum(['not_needed', 'approved', 'declined', 'waiting_in_console', 'waiting_in_paypal']),
  method: z.enum(['policy', 'console', 'elicitation', 'paypal_link', 'none']),
  approval_url: z.string().nullable().describe("PayPal's own approval page, when the owner approves there. Null when the link went straight to the client or is not needed."),
  note: z.string()
});
type ApprovalOut = z.infer<typeof approvalSchema>;

function approvalMessage(ctx: ToolContext, result: PayResult, supplier: string): string {
  const p = result.payment as PublicPayment;
  const why = result.policy.reasons.filter((r) => r.effect === 'step_up').map((r) => r.text).join(' ');
  return `Approve ${formatMoney(p.requestedMinor, ctx.money)} to ${supplier}? ${why} The money is held on PayPal and charged only for what is delivered.`;
}

/**
 * The approval ladder for a step-up payment (owner decision, M2):
 * console -> the owner's console card; other clients -> in-client form
 * (elicitation), else PayPal's approval page (opened by the client when it
 * can, otherwise returned as a link), else decline with a reason.
 */
async function obtainApproval(ctx: ToolContext, bridge: PaymentsBridge, result: PayResult, supplier: string): Promise<{ approval: ApprovalOut; payment: PublicPayment }> {
  let payment = result.payment as PublicPayment;
  const token = result.approval?.token ?? null;
  if (ctx.approvals.kind === 'console') {
    return { payment, approval: { state: 'waiting_in_console', method: 'console', approval_url: null, note: 'Waiting for the owner in the ShopVoice console.' } };
  }
  if (token) {
    const answer = await ctx.approvals.confirm(approvalMessage(ctx, result, supplier));
    if (answer === 'accept') {
      try {
        const approved = await bridge.service.approve(bridge.ctx, token, 'owner_elicitation');
        payment = approved.payment;
        if (!approved.payerActionUrl) return { payment, approval: { state: 'approved', method: 'elicitation', approval_url: null, note: 'Approved by the owner in the client.' } };
        // Approved, but with no saved PayPal account the owner still confirms this one order on PayPal.
        const opened = await ctx.approvals.openUrl(`Finish paying ${supplier} in PayPal.`, approved.payerActionUrl);
        return { payment, approval: { state: 'waiting_in_paypal', method: 'paypal_link', approval_url: opened === 'unavailable' ? approved.payerActionUrl : null, note: 'Approved; PayPal asks the owner to confirm this order.' } };
      } catch (error) {
        if (!(error instanceof PaymentFlowError)) throw error;
        return { payment: (await bridge.service.explain(bridge.ctx, payment.paymentId)).payment, approval: { state: 'declined', method: 'elicitation', approval_url: null, note: error.message } };
      }
    }
    if (answer === 'decline') {
      payment = await bridge.service.decline(bridge.ctx, token);
      return { payment, approval: { state: 'declined', method: 'elicitation', approval_url: null, note: 'The owner declined in the client.' } };
    }
  }
  try {
    const { approveUrl, payment: waiting } = await bridge.service.startPayPalApproval(bridge.ctx, payment.paymentId);
    const opened = await ctx.approvals.openUrl(`Approve ${formatMoney(waiting.requestedMinor, ctx.money)} to ${supplier} in PayPal.`, approveUrl);
    return { payment: waiting, approval: { state: 'waiting_in_paypal', method: 'paypal_link', approval_url: opened === 'unavailable' ? approveUrl : null, note: 'Waiting for the owner to approve on PayPal.' } };
  } catch (error) {
    if (!(error instanceof PaymentFlowError) && !isPayPalError(error)) throw error;
    const reason = error instanceof PaymentFlowError && error.code === 'blocked_on_recheck'
      ? error.message
      : "I couldn't get an approval request to you, so I didn't pay.";
    if (token) payment = await bridge.service.decline(bridge.ctx, token).catch(() => payment);
    return { payment: (await bridge.service.explain(bridge.ctx, payment.paymentId)).payment, approval: { state: 'declined', method: 'none', approval_url: null, note: reason } };
  }
}

function paymentPhrase(ctx: ToolContext, p: PublicPayment, approval: ApprovalOut, reasons: readonly PolicyReason[], supplier: string): { short: string; why: string | null } {
  const amount = formatMoney(p.requestedMinor, ctx.money);
  const head = headlineReason(reasons);
  if (p.status === 'authorized') return { short: `${supplier} ${formatMoney(p.heldMinor, ctx.money)} held until delivery`, why: null };
  if (p.status === 'blocked') return { short: `${supplier} not paid`, why: head ? `${supplier}: ${shortReason(head)}.` : null };
  if (approval.state === 'waiting_in_console') return { short: `${supplier} ${amount} needs your OK`, why: head ? `${capitalize(shortReason(head))}.` : null };
  if (approval.state === 'waiting_in_paypal') return { short: `${supplier} ${amount} needs your OK in PayPal`, why: approval.approval_url ? 'Open the PayPal link to approve.' : 'Approve it on the PayPal page.' };
  if (approval.state === 'declined') return { short: `${supplier} not paid`, why: approval.note };
  if (p.status === 'failed') return { short: `${supplier} not paid, PayPal declined the hold`, why: null };
  return { short: `${supplier} ${describeStatus(p)}`, why: null };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function policyDraftOf(ctx: ToolContext, d: DraftRow, supplier: string) {
  return {
    id: d.id,
    supplierId: d.supplierCode,
    supplierName: supplier,
    lines: d.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitCostMinor: l.unitCostMinor })),
    totalMinor: d.totalMinor,
    currency: ctx.money.currency
  };
}

export const confirmReorder = defineTool({
  name: 'confirm_reorder',
  title: 'Confirm and pay a reorder (step 2 of 2)',
  description: 'Confirms the purchase-order drafts from one create_reorder_draft call (confirmation_token, valid 5 minutes) and pays each supplier through PayPal within the owner\'s spending rules. Orders within the rules are held on PayPal and charged only for what is delivered; orders that need approval wait for the owner, who approves outside this conversation; orders the rules block are not paid. Confirming the same drafts again reports their payments without paying twice.',
  input: {
    confirmation_token: z.string().trim().min(8).max(64)
  },
  output: {
    status: z.enum(['confirmed', 'already_confirmed', 'expired', 'not_found']),
    confirmed_count: z.number().int(),
    ...moneyOut,
    total_minor: z.number(),
    total: z.number(),
    drafts: z.array(z.object({ draft_id: z.string(), supplier_code: z.string(), supplier_name: z.string(), status: z.string(), total: z.number() })),
    payments_enabled: z.boolean(),
    payments: z.array(paymentSchema.extend({ approval: approvalSchema }))
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  session: true,
  redact: () => ({ confirmation_token: '[redacted]' }),
  async run(ctx, args) {
    const drafts = await ctx.repo.findDraftsByTokenHash(hashConfirmationToken(args.confirmation_token));
    const names = await supplierNames(ctx.repo);
    const totalMinor = drafts.reduce((n, d) => n + d.totalMinor, 0);
    const base = { currency: ctx.money.currency, total_minor: totalMinor, total: minorToDisplay(totalMinor, ctx.money), payments_enabled: !!ctx.payments };
    const out = (status: string) => drafts.map((d) => ({
      draft_id: d.id, supplier_code: d.supplierCode, supplier_name: nameOf(names, d.supplierCode),
      status: d.status === 'draft' ? status : d.status, total: minorToDisplay(d.totalMinor, ctx.money)
    }));

    if (drafts.length === 0) {
      return { speech: "I couldn't find that draft. Want me to create a new reorder?", data: { status: 'not_found' as const, confirmed_count: 0, ...base, drafts: [], payments: [] } };
    }
    const pending = drafts.filter((d) => d.status === 'draft');
    if (pending.length > 0 && pending.some((d) => d.expired)) {
      return { speech: 'That draft expired after 5 minutes, so nothing was ordered or paid. Want me to make a fresh one?', data: { status: 'expired' as const, confirmed_count: 0, ...base, drafts: out('expired'), payments: [] } };
    }
    const count = pending.length > 0 ? await ctx.repo.confirmDrafts(pending.map((d) => d.id)) : 0;
    const status = pending.length > 0 ? 'confirmed' as const : 'already_confirmed' as const;
    const confirmedDrafts = drafts.filter((d) => d.status === 'draft' || d.status === 'confirmed');
    const supplierList = joinList([...new Set(confirmedDrafts.map((d) => nameOf(names, d.supplierCode)))]);

    if (!ctx.payments) {
      const speech = status === 'confirmed'
        ? fitSpeech([`Done. ${count === 1 ? 'Your order' : `${countWord(count, true)} orders`} to ${supplierList} ${count === 1 ? 'is' : 'are'} confirmed, about ${formatMoney(totalMinor, ctx.money)}. No payment was made.`, `Done. ${countWord(count, true)} ${count === 1 ? 'order' : 'orders'} confirmed. No payment was made.`])
        : 'Those orders were already confirmed. Nothing else to do.';
      return { speech, data: { status, confirmed_count: count, ...base, drafts: out('confirmed'), payments: [] } };
    }

    const bridge = ctx.payments;
    const payments: (PaymentOut & { approval: ApprovalOut })[] = [];
    const shorts: string[] = [];
    const whys: string[] = [];
    for (const d of confirmedDrafts) {
      const supplier = nameOf(names, d.supplierCode);
      const result = await bridge.service.payForDraft(bridge.ctx, policyDraftOf(ctx, d, supplier), 'agent');
      if (!result.payment) continue;
      let payment = result.payment;
      let approval: ApprovalOut = { state: 'not_needed', method: 'policy', approval_url: null, note: result.policy.summary };
      if (payment.status === 'pending_approval' && payment.decision === 'step_up') {
        ({ payment, approval } = await obtainApproval(ctx, bridge, result, supplier));
      } else if (payment.status === 'blocked') {
        approval = { state: 'declined', method: 'policy', approval_url: null, note: result.policy.summary };
      }
      payments.push({ ...paymentOut(ctx, payment, names), approval });
      const phrase = paymentPhrase(ctx, payment, approval, result.policy.reasons, supplier);
      shorts.push(phrase.short);
      if (phrase.why) whys.push(phrase.why);
    }

    const lead = status === 'confirmed' ? `Done. ${countWord(count, true)} ${count === 1 ? 'order' : 'orders'} confirmed` : 'Already confirmed';
    const speech = fitSpeech([
      `${lead}: ${speakList(shorts, 3)}. ${whys.slice(0, 1).join(' ')}`.trim(),
      `${lead}: ${speakList(shorts, 3)}.`,
      `${lead}. ${shorts[0] ?? ''}${shorts.length > 1 ? `, and ${shorts.length - 1} more` : ''}.`
    ]);
    return { speech, data: { status, confirmed_count: count, ...base, drafts: out('confirmed'), payments } };
  }
});

// ---------- spending policy ----------

const policySchema = z.object({
  per_order_autopay_max: z.number(),
  daily_budget: z.number(),
  weekly_budget: z.number(),
  daily_hard_cap: z.number().nullable(),
  weekly_hard_cap: z.number().nullable(),
  approved_suppliers: z.array(z.object({ supplier_code: z.string(), supplier_name: z.string() })),
  price_jump_pct: z.number().int(),
  quantity_spike_multiplier: z.number().int(),
  substitution_tolerance_pct: z.number().int()
});

function policyOut(ctx: ToolContext, p: SpendPolicy, names: Map<string, string>): z.infer<typeof policySchema> {
  const d = (m: number) => minorToDisplay(m, ctx.money);
  return {
    per_order_autopay_max: d(p.perOrderAutopayMaxMinor),
    daily_budget: d(p.dailyMaxMinor),
    weekly_budget: d(p.weeklyMaxMinor),
    daily_hard_cap: p.dailyHardCapMinor === null ? null : d(p.dailyHardCapMinor),
    weekly_hard_cap: p.weeklyHardCapMinor === null ? null : d(p.weeklyHardCapMinor),
    approved_suppliers: p.allowListedSupplierIds.map((code) => ({ supplier_code: code, supplier_name: nameOf(names, code) })),
    price_jump_pct: p.priceJumpPct,
    quantity_spike_multiplier: p.quantitySpikeMultiplier,
    substitution_tolerance_pct: p.substitutionTolerancePct
  };
}

export const getSpendingPolicy = defineTool({
  name: 'get_spending_policy',
  title: 'Spending rules',
  description: "The owner's supplier spending rules: auto-pay limit per order, daily and weekly budgets, hard caps, approved suppliers, and the price-jump and quantity checks that ask the owner first. Also whether a PayPal account is connected.",
  input: {},
  output: {
    ...moneyOut,
    configured: z.boolean(),
    paypal_connected: z.boolean(),
    paypal_account: z.string().nullable(),
    policy: policySchema
  },
  annotations: READ_ONLY,
  async run(ctx) {
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { currency: ctx.money.currency, configured: false, paypal_connected: false, paypal_account: null, policy: policyOut(ctx, emptyPolicy(ctx), new Map()) } };
    const names = await supplierNames(ctx.repo);
    const summary = await ctx.payments.service.spendSummary(ctx.payments.ctx, ctx.money.currency);
    const p = summary.policy;
    const m = (v: number) => formatMoney(v, ctx.money);
    const approved = p.allowListedSupplierIds.map((c) => nameOf(names, c));
    const caps = p.dailyHardCapMinor !== null && p.weeklyHardCapMinor !== null ? ` Hard caps ${m(p.dailyHardCapMinor)} a day, ${m(p.weeklyHardCapMinor)} a week.` : '';
    const speech = !summary.configured
      ? 'No spending rules are set yet, so I will not pay any supplier. Set them in the ShopVoice console.'
      : fitSpeech([
        `Auto-pay up to ${m(p.perOrderAutopayMaxMinor)} an order, ${m(p.dailyMaxMinor)} a day, ${m(p.weeklyMaxMinor)} a week.${caps} Approved suppliers: ${joinList(approved)}.`,
        `Auto-pay up to ${m(p.perOrderAutopayMaxMinor)} an order, ${m(p.dailyMaxMinor)} a day, ${m(p.weeklyMaxMinor)} a week. ${countWord(approved.length, true)} approved suppliers.`
      ]);
    return {
      speech,
      data: { currency: ctx.money.currency, configured: summary.configured, paypal_connected: summary.paypalConnected, paypal_account: summary.payerLabel, policy: policyOut(ctx, p, names) }
    };
  }
});

function emptyPolicy(ctx: ToolContext): SpendPolicy {
  return { currency: ctx.money.currency, perOrderAutopayMaxMinor: 0, dailyMaxMinor: 0, weeklyMaxMinor: 0, dailyHardCapMinor: 0, weeklyHardCapMinor: 0, allowListedSupplierIds: [], priceJumpPct: 20, substitutionTolerancePct: 5, quantitySpikeMultiplier: 3, requireDeliveryCheck: true };
}

const amountIn = z.number().min(0).max(1_000_000);

/** Which changes widen what can be paid without asking (they need the owner, outside the model). */
export function looserChanges(before: SpendPolicy, after: SpendPolicy): string[] {
  const out: string[] = [];
  const up = (a: number, b: number) => b > a;
  const capUp = (a: number | null, b: number | null) => a !== null && (b === null || b > a);
  if (up(before.perOrderAutopayMaxMinor, after.perOrderAutopayMaxMinor)) out.push('auto-pay limit');
  if (up(before.dailyMaxMinor, after.dailyMaxMinor)) out.push('daily budget');
  if (up(before.weeklyMaxMinor, after.weeklyMaxMinor)) out.push('weekly budget');
  if (capUp(before.dailyHardCapMinor, after.dailyHardCapMinor)) out.push('daily hard cap');
  if (capUp(before.weeklyHardCapMinor, after.weeklyHardCapMinor)) out.push('weekly hard cap');
  if (after.allowListedSupplierIds.some((c) => !before.allowListedSupplierIds.includes(c))) out.push('approved suppliers');
  if (up(before.priceJumpPct, after.priceJumpPct)) out.push('price-jump check');
  if (up(before.quantitySpikeMultiplier, after.quantitySpikeMultiplier)) out.push('quantity check');
  if (up(before.substitutionTolerancePct, after.substitutionTolerancePct)) out.push('substitution tolerance');
  return out;
}

function samePolicy(a: SpendPolicy, b: SpendPolicy): boolean {
  return JSON.stringify({ ...a, allowListedSupplierIds: [...a.allowListedSupplierIds].sort() }) === JSON.stringify({ ...b, allowListedSupplierIds: [...b.allowListedSupplierIds].sort() });
}

function resolveSuppliers(names: Map<string, string>, queries: readonly string[]): { codes: string[]; unknown: string[] } {
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const q of queries) {
    const hit = [...names.entries()].find(([code, name]) => supplierMatches({ supplierCode: code, supplierName: name }, q));
    if (hit) codes.push(hit[0]); else unknown.push(q);
  }
  return { codes, unknown };
}

export const setSpendingPolicy = defineTool({
  name: 'set_spending_policy',
  title: 'Change spending rules',
  description: 'Changes the owner\'s supplier spending rules. Amounts are in the shop currency (e.g. 150 for $150). Lowering a limit or removing a supplier takes effect at once. Raising a limit, removing a hard cap or approving a new supplier widens what can be paid without asking, so the owner approves it outside this conversation (the client\'s own confirmation form, or the ShopVoice console); otherwise nothing changes.',
  input: {
    per_order_autopay_max: amountIn.optional(),
    daily_budget: amountIn.optional(),
    weekly_budget: amountIn.optional(),
    daily_hard_cap: amountIn.nullable().optional().describe('null removes the cap.'),
    weekly_hard_cap: amountIn.nullable().optional().describe('null removes the cap.'),
    approve_suppliers: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
    remove_suppliers: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
    price_jump_pct: z.number().int().min(1).max(500).optional(),
    quantity_spike_multiplier: z.number().int().min(2).max(20).optional(),
    substitution_tolerance_pct: z.number().int().min(0).max(50).optional()
  },
  output: {
    status: z.enum(['applied', 'unchanged', 'needs_owner', 'declined', 'invalid']),
    approved_by: z.enum(['not_needed', 'elicitation']).nullable(),
    looser_changes: z.array(z.string()),
    ...moneyOut,
    policy: policySchema,
    problem: z.string().nullable()
  },
  annotations: SESSION_WRITE,
  session: true,
  async run(ctx, args) {
    const names = await supplierNames(ctx.repo);
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { status: 'invalid' as const, approved_by: null, looser_changes: [], currency: ctx.money.currency, policy: policyOut(ctx, emptyPolicy(ctx), names), problem: 'payments_not_configured' } };
    const bridge = ctx.payments;
    const { policy: before } = await bridge.service.getPolicy(bridge.ctx, ctx.money.currency);
    const toMinor = (v: number) => Math.round(v * ctx.money.minorPerUnit);
    const add = resolveSuppliers(names, args.approve_suppliers ?? []);
    const remove = resolveSuppliers(names, args.remove_suppliers ?? []);
    const allow = new Set(before.allowListedSupplierIds);
    for (const c of add.codes) allow.add(c);
    for (const c of remove.codes) allow.delete(c);
    const after: SpendPolicy = {
      ...before,
      ...(args.per_order_autopay_max !== undefined ? { perOrderAutopayMaxMinor: toMinor(args.per_order_autopay_max) } : {}),
      ...(args.daily_budget !== undefined ? { dailyMaxMinor: toMinor(args.daily_budget) } : {}),
      ...(args.weekly_budget !== undefined ? { weeklyMaxMinor: toMinor(args.weekly_budget) } : {}),
      ...(args.daily_hard_cap !== undefined ? { dailyHardCapMinor: args.daily_hard_cap === null ? null : toMinor(args.daily_hard_cap) } : {}),
      ...(args.weekly_hard_cap !== undefined ? { weeklyHardCapMinor: args.weekly_hard_cap === null ? null : toMinor(args.weekly_hard_cap) } : {}),
      ...(args.price_jump_pct !== undefined ? { priceJumpPct: args.price_jump_pct } : {}),
      ...(args.quantity_spike_multiplier !== undefined ? { quantitySpikeMultiplier: args.quantity_spike_multiplier } : {}),
      ...(args.substitution_tolerance_pct !== undefined ? { substitutionTolerancePct: args.substitution_tolerance_pct } : {}),
      allowListedSupplierIds: [...allow]
    };
    const data = (status: 'applied' | 'unchanged' | 'needs_owner' | 'declined' | 'invalid', approvedBy: 'not_needed' | 'elicitation' | null, looser: string[], shown: SpendPolicy, problem: string | null) => ({
      status, approved_by: approvedBy, looser_changes: looser, currency: ctx.money.currency, policy: policyOut(ctx, shown, names), problem
    });

    const unknown = [...add.unknown, ...remove.unknown];
    if (unknown.length > 0) {
      return { speech: `I don't know a supplier called ${joinList(unknown.map((u) => `"${u}"`))}, so I changed nothing.`, data: data('invalid', null, [], before, 'unknown_supplier') };
    }
    if ((after.dailyHardCapMinor !== null && after.dailyHardCapMinor < after.dailyMaxMinor) || (after.weeklyHardCapMinor !== null && after.weeklyHardCapMinor < after.weeklyMaxMinor)) {
      return { speech: 'A hard cap has to be at least the budget it backs up, so I changed nothing.', data: data('invalid', null, [], before, 'hard_cap_below_budget') };
    }
    if (samePolicy(before, after)) return { speech: 'Those are already your rules. Nothing changed.', data: data('unchanged', null, [], before, null) };

    const looser = looserChanges(before, after);
    if (looser.length === 0) {
      await bridge.service.savePolicy(bridge.ctx, after);
      return { speech: 'Done. Your spending rules are tighter now.', data: data('applied', 'not_needed', [], after, null) };
    }
    const what = joinList(looser);
    if (ctx.approvals.kind === 'client') {
      const answer = await ctx.approvals.confirm(`Allow ShopVoice to pay more without asking? This changes your ${what}.`);
      if (answer === 'accept') {
        await bridge.service.savePolicy(bridge.ctx, after);
        return { speech: `Done. You approved the new ${what}.`, data: data('applied', 'elicitation', looser, after, null) };
      }
      if (answer === 'decline') return { speech: 'OK, I left your spending rules as they were.', data: data('declined', null, looser, before, null) };
    }
    return {
      speech: fitSpeech([`Raising your ${what} needs your own approval, so I changed nothing. You can change it in the Policy tab of the ShopVoice console.`, 'That loosens your spending rules, so I changed nothing. Change it in the ShopVoice console.']),
      data: data('needs_owner', null, looser, before, null)
    };
  }
});

// ---------- status, spend, explain ----------

export const getPaymentStatus = defineTool({
  name: 'get_payment_status',
  title: 'Supplier payment status',
  description: 'Latest supplier payments and where each stands: waiting for approval, held on PayPal (not charged), charged for what arrived, released, refunded, or blocked by the rules. Holds stay valid 29 days; PayPal honors them in full for the first 3. Filter by supplier or payment id.',
  input: { ...lookupInput, limit: z.number().int().min(1).max(10).default(3) },
  output: { ...moneyOut, payments: z.array(paymentSchema) },
  annotations: READ_ONLY,
  async run(ctx, args) {
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { currency: ctx.money.currency, payments: [] } };
    const names = await supplierNames(ctx.repo);
    const all = await ctx.payments.service.listPublicPayments(ctx.payments.ctx, 200);
    const picked = all.filter((p) => {
      if (args.payment_id) return p.paymentId === args.payment_id;
      if (args.supplier) return supplierMatches({ supplierCode: p.supplierCode, supplierName: nameOf(names, p.supplierCode) }, args.supplier);
      return true;
    }).slice(0, args.limit);
    const payments = picked.map((p) => paymentOut(ctx, p, names));
    let speech: string;
    const first = picked[0];
    if (!first) {
      speech = args.supplier ? `I don't see a payment for "${args.supplier}".` : 'There are no supplier payments yet.';
    } else if (picked.length === 1 || args.supplier || args.payment_id) {
      const expires = first.status === 'authorized' || first.status === 'partially_captured' ? dayOf(first.holdExpiresAt, ctx) : null;
      speech = fitSpeech([
        `${nameOf(names, first.supplierCode)}, ${formatMoney(first.requestedMinor, ctx.money)}: ${describeStatus(first)}.${expires && first.heldMinor > 0 ? ` The hold lasts until ${expires}.` : ''}`,
        `${nameOf(names, first.supplierCode)}: ${describeStatus(first)}.`
      ]);
    } else {
      speech = fitSpeech([
        `Latest payments: ${speakList(picked.map((p) => `${nameOf(names, p.supplierCode)}, ${describeStatus(p)}`))}.`,
        `Latest payments: ${speakList(picked.map((p) => nameOf(names, p.supplierCode)))}.`
      ]);
    }
    return { speech, data: { currency: ctx.money.currency, payments } };
  }
});

export const getSpendSummary = defineTool({
  name: 'get_spend_summary',
  title: 'Supplier spend vs budget',
  description: "Supplier money committed today and this week (held plus charged) against the owner's budgets, how much is held on PayPal awaiting deliveries, and how many payments wait for the owner's approval.",
  input: {},
  output: {
    ...moneyOut,
    today_committed: z.number(),
    daily_budget: z.number(),
    week_committed: z.number(),
    weekly_budget: z.number(),
    held: z.number(),
    pending_approvals: z.number().int(),
    paypal_connected: z.boolean()
  },
  annotations: READ_ONLY,
  async run(ctx) {
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { currency: ctx.money.currency, today_committed: 0, daily_budget: 0, week_committed: 0, weekly_budget: 0, held: 0, pending_approvals: 0, paypal_connected: false } };
    const s = await ctx.payments.service.spendSummary(ctx.payments.ctx, ctx.money.currency);
    const m = (v: number) => formatMoney(v, ctx.money);
    const pending = s.pendingApprovals === 0 ? '' : ` ${countWord(s.pendingApprovals, true)} ${s.pendingApprovals === 1 ? 'payment waits' : 'payments wait'} for your OK.`;
    const speech = fitSpeech([
      `This week: ${m(s.weekCommittedMinor)} of your ${m(s.policy.weeklyMaxMinor)} budget; today ${m(s.todayCommittedMinor)} of ${m(s.policy.dailyMaxMinor)}. ${m(s.heldMinor)} is held until deliveries arrive.${pending}`,
      `This week: ${m(s.weekCommittedMinor)} of ${m(s.policy.weeklyMaxMinor)}; today ${m(s.todayCommittedMinor)} of ${m(s.policy.dailyMaxMinor)}.${pending}`
    ]);
    const d = (v: number) => minorToDisplay(v, ctx.money);
    return {
      speech,
      data: {
        currency: ctx.money.currency, today_committed: d(s.todayCommittedMinor), daily_budget: d(s.policy.dailyMaxMinor), week_committed: d(s.weekCommittedMinor),
        weekly_budget: d(s.policy.weeklyMaxMinor), held: d(s.heldMinor), pending_approvals: s.pendingApprovals, paypal_connected: s.paypalConnected
      }
    };
  }
});

export const explainPayment = defineTool({
  name: 'explain_payment',
  title: 'Why a payment happened',
  description: 'Explains one supplier payment: why the rules auto-paid it, asked the owner first, or blocked it, and what happened since (holds, deliveries, charges, releases, refunds), in order. Defaults to the latest payment.',
  input: lookupInput,
  output: {
    ...moneyOut,
    found: z.boolean(),
    payment: paymentSchema.nullable(),
    events: z.array(z.object({ kind: z.string(), amount: z.number(), actor: z.string(), reason: z.string(), at: z.string() }))
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { currency: ctx.money.currency, found: false, payment: null, events: [] } };
    const names = await supplierNames(ctx.repo);
    const hit = await findPayment(ctx.payments, names, args, () => true);
    if (!hit) return { speech: args.supplier ? `I don't see a payment for "${args.supplier}".` : 'There are no supplier payments yet.', data: { currency: ctx.money.currency, found: false, payment: null, events: [] } };
    const { payment, events } = await ctx.payments.service.explain(ctx.payments.ctx, hit.paymentId);
    const supplier = nameOf(names, payment.supplierCode);
    const amount = formatMoney(payment.requestedMinor, ctx.money);
    const why = payment.decision === 'autopay'
      ? 'it was within your rules'
      : payment.decision === 'step_up'
        ? `it needed your OK: ${payment.reasons[0]?.replace(/\.$/, '') ?? 'over your limits'}`
        : `your rules blocked it: ${payment.reasons[0]?.replace(/\.$/, '') ?? 'not allowed'}`;
    const speech = fitSpeech([
      `${supplier}, ${amount}: ${describeStatus(payment)}. ${capitalize(why)}.`,
      `${supplier}, ${amount}: ${describeStatus(payment)}.`
    ]);
    return {
      speech,
      data: {
        currency: ctx.money.currency, found: true, payment: paymentOut(ctx, payment, names),
        events: events.map((e) => ({ kind: e.kind, amount: minorToDisplay(e.amountMinor, ctx.money), actor: e.actor, reason: e.reason, at: e.at }))
      }
    };
  }
});

// ---------- deliveries: pay only for what arrived ----------

function lineMatches(line: { sku: string; name: string }, query: string): boolean {
  const q = query.toLowerCase();
  if (line.sku.toLowerCase() === q) return true;
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['the', 'of', 'and', 'cases', 'case', 'crates', 'crate'].includes(w));
  const hay = line.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, '') : w);
  return words.length > 0 && words.every((w) => hay.some((h) => h.startsWith(stem(w))));
}

export const recordDelivery = defineTool({
  name: 'record_delivery',
  title: 'Record a delivery',
  description: 'Records what a supplier actually delivered for a held payment, then charges only for what arrived and releases the rest of the hold; the supplier is paid for what was charged. Pass everything_arrived, nothing_arrived, or items with the received quantity of each ordered product. Defaults to the latest open payment for the supplier.',
  input: {
    ...lookupInput,
    everything_arrived: z.boolean().optional(),
    nothing_arrived: z.boolean().optional(),
    items: z.array(z.object({ product: z.string().trim().min(2).max(80), received_qty: z.number().int().min(0).max(100_000) })).max(30).optional()
  },
  output: {
    status: z.enum(['recorded', 'needs_clarification', 'no_open_order']),
    outcome: z.enum(['full', 'partial', 'hold', 'none']).nullable(),
    ...moneyOut,
    charged: z.number(),
    released: z.number(),
    supplier_paid: z.number(),
    payment: paymentSchema.nullable(),
    missing_lines: z.array(z.object({ sku: z.string(), name: z.string(), ordered_qty: z.number() })),
    unknown_items: z.array(z.string())
  },
  annotations: SESSION_WRITE,
  session: true,
  async run(ctx, args) {
    const empty = { outcome: null, currency: ctx.money.currency, charged: 0, released: 0, supplier_paid: 0, payment: null, missing_lines: [], unknown_items: [] };
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { status: 'no_open_order' as const, ...empty } };
    const bridge = ctx.payments;
    const names = await supplierNames(ctx.repo);
    const isOpen = (p: PublicPayment) => (p.status === 'authorized' || p.status === 'partially_captured') && p.heldMinor > 0;
    let open = await findPayment(bridge, names, args, isOpen);
    if (!open && args.supplier && !args.payment_id) {
      // "The milk came": match a product on an open order, not only the supplier's name.
      for (const p of (await bridge.service.listPublicPayments(bridge.ctx, 200)).filter(isOpen)) {
        const raw = await ctx.repo.payments.getPayment(p.paymentId);
        if (raw?.lines.some((l) => lineMatches(l, args.supplier ?? ''))) {
          open = p;
          break;
        }
      }
    }
    if (!open) {
      return { speech: args.supplier ? `I don't see an order from "${args.supplier}" waiting for delivery.` : "I don't see an order waiting for delivery.", data: { status: 'no_open_order' as const, ...empty } };
    }
    const supplier = nameOf(names, open.supplierCode);
    const lines = (await ctx.repo.payments.getPayment(open.paymentId))?.lines ?? [];
    let received: { sku: string; receivedQty: number }[];
    if (args.nothing_arrived) {
      received = [];
    } else if (args.everything_arrived) {
      received = lines.map((l) => ({ sku: l.sku, receivedQty: l.qty }));
    } else {
      const items = args.items ?? [];
      const unknown: string[] = [];
      received = [];
      for (const item of items) {
        const line = lines.find((l) => lineMatches(l, item.product));
        if (!line) unknown.push(item.product);
        else received.push({ sku: line.sku, receivedQty: item.received_qty });
      }
      const missing = lines.filter((l) => !received.some((r) => r.sku === l.sku));
      if (items.length === 0 || unknown.length > 0 || missing.length > 0) {
        const ask = unknown.length > 0
          ? `That order from ${supplier} has no "${unknown[0]}". It has ${joinList(lines.map((l) => l.name))}.`
          : `How much of ${joinList(missing.map((l) => l.name))} arrived from ${supplier}?`;
        return {
          speech: fitSpeech([`${ask} Nothing is charged yet.`, ask]),
          data: { status: 'needs_clarification' as const, ...empty, payment: paymentOut(ctx, open, names), missing_lines: missing.map((l) => ({ sku: l.sku, name: l.name, ordered_qty: l.qty })), unknown_items: unknown }
        };
      }
    }
    const heldBefore = open.heldMinor;
    const result = await bridge.service.recordDelivery(bridge.ctx, open.paymentId, received, 'voice');
    let payment = result.payment;
    let paidMinor = 0;
    let speech = result.speech;
    if (payment.heldMinor === 0 && payment.chargedMinor > 0) {
      try {
        const settled = await bridge.service.settle(bridge.ctx, payment.paymentId);
        payment = settled.payment;
        paidMinor = settled.paidMinor;
      } catch (error) {
        if (!(error instanceof PaymentFlowError) && !(error instanceof LedgerError) && !isPayPalError(error)) throw error;
        speech = `${speech} The supplier payout is pending.`;
      }
    }
    const charged = result.outcome === 'hold' ? 0 : payment.chargedMinor - (open.chargedMinor);
    const released = result.outcome === 'hold' ? 0 : Math.max(0, heldBefore - payment.heldMinor - charged);
    return {
      speech: fitSpeech([speech]),
      data: {
        status: 'recorded' as const, outcome: result.outcome, currency: ctx.money.currency,
        charged: minorToDisplay(charged, ctx.money), released: minorToDisplay(released, ctx.money), supplier_paid: minorToDisplay(paidMinor, ctx.money),
        payment: paymentOut(ctx, payment, names), missing_lines: [], unknown_items: []
      }
    };
  }
});

// ---------- refunds (two-step) ----------

const REFUND_TTL_SECONDS = 300;

export const requestRefund = defineTool({
  name: 'request_refund',
  title: 'Refund a supplier charge (two steps)',
  description: 'Refunds money charged for a supplier order back to the owner\'s PayPal, for example for spoiled or wrong goods. First call (no confirmation_token) returns the refund amount and a confirmation_token valid 5 minutes; a second call with that token makes the refund. amount is in the shop currency and defaults to everything charged.',
  input: {
    ...lookupInput,
    amount: z.number().positive().max(1_000_000).optional(),
    reason: z.string().trim().min(3).max(200),
    confirmation_token: z.string().trim().min(10).max(200).optional()
  },
  output: {
    status: z.enum(['needs_confirmation', 'refunded', 'expired', 'invalid', 'nothing_to_refund']),
    confirmation_token: z.string().nullable(),
    ...moneyOut,
    amount: z.number(),
    payment: paymentSchema.nullable()
  },
  annotations: SESSION_WRITE,
  session: true,
  redact: (args) => ({ ...args, confirmation_token: args.confirmation_token ? '[redacted]' : undefined }),
  async run(ctx, args) {
    const none = { confirmation_token: null, currency: ctx.money.currency, amount: 0, payment: null };
    if (!ctx.payments) return { speech: NOT_SET_UP, data: { status: 'nothing_to_refund' as const, ...none } };
    const bridge = ctx.payments;
    const names = await supplierNames(ctx.repo);
    const tenant = ctx.profile.tenantId;

    if (args.confirmation_token) {
      const [prefix, paymentId = '', amountText = '', ...sig] = args.confirmation_token.split('.');
      const amountMinor = Number(amountText);
      const verdict = prefix === 'rf' && Number.isSafeInteger(amountMinor) ? bridge.service.verifyConfirmation('refund', [tenant, paymentId, amountText], sig.join('.')) : 'invalid';
      if (verdict !== 'ok') {
        return { speech: verdict === 'expired' ? 'That refund request expired. Ask me again to start a new one.' : "That refund confirmation doesn't match. Ask me again to start a new one.", data: { status: verdict, ...none } };
      }
      try {
        const done = await bridge.service.refund(bridge.ctx, paymentId, amountMinor, args.reason);
        return { speech: done.speech, data: { status: 'refunded' as const, confirmation_token: null, currency: ctx.money.currency, amount: minorToDisplay(done.refundedMinor, ctx.money), payment: paymentOut(ctx, done.payment, names) } };
      } catch (error) {
        if (!(error instanceof PaymentFlowError) && !(error instanceof LedgerError)) throw error;
        return { speech: error.message.endsWith('.') ? error.message : `${error.message}.`, data: { status: 'invalid' as const, ...none } };
      }
    }

    // Only charges with a real PayPal capture can be refunded (seeded history has none).
    let target: PublicPayment | null = null;
    for (const p of (await bridge.service.listPublicPayments(bridge.ctx, 200)).filter((x) => x.chargedMinor > 0 && x.heldMinor === 0)) {
      const matches = args.payment_id ? p.paymentId === args.payment_id : !args.supplier || supplierMatches({ supplierCode: p.supplierCode, supplierName: nameOf(names, p.supplierCode) }, args.supplier);
      if (!matches) continue;
      const raw = await ctx.repo.payments.getPayment(p.paymentId);
      if (raw && raw.paypalCaptureIds.length > 0) {
        target = p;
        break;
      }
    }
    if (!target) return { speech: args.supplier ? `I don't see a PayPal charge from "${args.supplier}" that can be refunded.` : "I don't see a PayPal charge that can be refunded.", data: { status: 'nothing_to_refund' as const, ...none } };
    const amountMinor = args.amount !== undefined ? Math.round(args.amount * ctx.money.minorPerUnit) : target.chargedMinor;
    if (amountMinor <= 0 || amountMinor > target.chargedMinor) {
      return { speech: `You can get back at most ${formatMoney(target.chargedMinor, ctx.money)} for that order.`, data: { status: 'invalid' as const, ...none, payment: paymentOut(ctx, target, names) } };
    }
    const signature = bridge.service.signConfirmation('refund', [tenant, target.paymentId, String(amountMinor)], REFUND_TTL_SECONDS);
    const token = `rf.${target.paymentId}.${amountMinor}.${signature}`;
    const supplier = nameOf(names, target.supplierCode);
    return {
      speech: `Refund ${formatMoney(amountMinor, ctx.money)} from ${supplier} to your PayPal? Say "confirm" within 5 minutes.`,
      data: { status: 'needs_confirmation' as const, confirmation_token: token, currency: ctx.money.currency, amount: minorToDisplay(amountMinor, ctx.money), payment: paymentOut(ctx, target, names) }
    };
  }
});

export const PAYMENT_TOOLS = [confirmReorder, getSpendingPolicy, setSpendingPolicy, getPaymentStatus, getSpendSummary, explainPayment, recordDelivery, requestRefund] as const;
