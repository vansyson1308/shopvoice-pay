// The spending policy engine: the only gate between "the agent proposed a
// payment" and "money moves". It is a pure, deterministic function, so the
// same input always gives the same decision. The LLM never calls it directly
// and cannot override it; MCP tools call it with data loaded server-side.
//
// Every reason carries plain-English text short enough for the agent to
// speak, because the owner hears why an order paid, paused or stopped.
import { linesFingerprint, averageUnitCost, percentChange, usualQuantity } from './anomaly.js';
import type { PriceObservation } from './anomaly.js';
import { speakMoney } from '../payments/money.js';

export type PolicyDecision = 'autopay' | 'step_up' | 'blocked';

export type ReasonCode =
  | 'invalid_amount'
  | 'currency_mismatch'
  | 'total_mismatch'
  | 'not_allow_listed'
  | 'no_payee'
  | 'payee_unverified'
  | 'duplicate_order'
  | 'over_daily_hard_cap'
  | 'over_weekly_hard_cap'
  | 'over_per_order_limit'
  | 'over_daily_budget'
  | 'over_weekly_budget'
  | 'price_jump'
  | 'first_order_with_supplier'
  | 'quantity_spike'
  | 'no_payment_method'
  | 'within_policy';

export interface PolicyReason {
  readonly code: ReasonCode;
  /** What this reason does to the decision. `info` never changes it. */
  readonly effect: 'block' | 'step_up' | 'info';
  readonly text: string;
  /** Machine-readable details for the ledger's "why" column. */
  readonly detail?: Readonly<Record<string, string | number>>;
}

export interface SpendPolicy {
  readonly currency: string;
  readonly perOrderAutopayMaxMinor: number;
  readonly dailyMaxMinor: number;
  readonly weeklyMaxMinor: number;
  /** Above this the order is blocked outright, even with approval. Null = no hard cap. */
  readonly dailyHardCapMinor: number | null;
  readonly weeklyHardCapMinor: number | null;
  readonly allowListedSupplierIds: readonly string[];
  /** Step up when a unit price rises more than this vs the 30-day average (default 20). */
  readonly priceJumpPct: number;
  /** Accept supplier substitutions within this price change (default 5). */
  readonly substitutionTolerancePct: number;
  /** Step up when a line is more than this multiple of the usual quantity (default 3). */
  readonly quantitySpikeMultiplier: number;
  readonly requireDeliveryCheck: boolean;
}

export const DEFAULT_POLICY: Omit<SpendPolicy, 'allowListedSupplierIds'> = {
  currency: 'USD',
  perOrderAutopayMaxMinor: 10_000,
  dailyMaxMinor: 50_000,
  weeklyMaxMinor: 150_000,
  dailyHardCapMinor: 100_000,
  weeklyHardCapMinor: 300_000,
  priceJumpPct: 20,
  substitutionTolerancePct: 5,
  quantitySpikeMultiplier: 3,
  requireDeliveryCheck: true
};

export interface PolicyDraftLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  readonly unitCostMinor: number;
}

export interface PolicyDraft {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly lines: readonly PolicyDraftLine[];
  readonly totalMinor: number;
  readonly currency: string;
}

/** One past supplier payment, as the ledger sees it. */
export interface SpendHistoryEntry {
  readonly paymentId: string;
  readonly draftId: string;
  readonly supplierId: string;
  /** Money currently held or charged by this payment, net of voids and refunds. */
  readonly committedMinor: number;
  readonly currency: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  readonly status: 'pending_approval' | 'authorized' | 'partially_captured' | 'captured' | 'voided' | 'refunded' | 'failed';
  readonly fingerprint: string;
}

export interface PolicyHistory {
  readonly payments: readonly SpendHistoryEntry[];
  /** Past unit costs per SKU (supplier price list history). */
  readonly priceHistory: Readonly<Record<string, readonly PriceObservation[]>>;
  /** Quantities of this SKU on past orders. */
  readonly pastQuantities: Readonly<Record<string, readonly number[]>>;
}

export interface PayeeStatus {
  readonly hasPayee: boolean;
  readonly verified: boolean;
  /** Completed (captured) orders with this supplier so far. */
  readonly completedOrders: number;
}

export interface PolicyInput {
  readonly draft: PolicyDraft;
  readonly history: PolicyHistory;
  readonly policy: SpendPolicy;
  readonly payee: PayeeStatus;
  /** Whether the owner has a vaulted PayPal account connected. */
  readonly paymentMethodConnected: boolean;
  readonly now: number;
  /** Start of the shop's current day and week (epoch ms), from `periodStarts`. */
  readonly dayStart: number;
  readonly weekStart: number;
}

export interface LimitsRemaining {
  readonly perOrderMinor: number;
  readonly dailyMinor: number;
  readonly weeklyMinor: number;
  readonly spentTodayMinor: number;
  readonly spentThisWeekMinor: number;
}

export interface PolicyResult {
  readonly decision: PolicyDecision;
  readonly reasons: readonly PolicyReason[];
  /** Headroom before this order is counted. */
  readonly limitsRemaining: LimitsRemaining;
  /** One sentence for the agent to speak. */
  readonly summary: string;
}

const DAY_MS = 86_400_000;
/** Payment states that hold or have moved money (and so count toward budgets and duplicates). */
const LIVE_STATUSES = new Set<SpendHistoryEntry['status']>(['pending_approval', 'authorized', 'partially_captured', 'captured', 'refunded']);
const SPEND_STATUSES = new Set<SpendHistoryEntry['status']>(['authorized', 'partially_captured', 'captured', 'refunded']);

function money(amountMinor: number, currency: string): string {
  return speakMoney({ amountMinor: Math.max(0, Math.round(amountMinor)), currency });
}

function isMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { draft, history, policy, payee, now } = input;
  const cur = policy.currency;
  const reasons: PolicyReason[] = [];
  const add = (code: ReasonCode, effect: PolicyReason['effect'], text: string, detail?: Record<string, string | number>) => {
    reasons.push({ code, effect, text, ...(detail ? { detail } : {}) });
  };

  const comparable = history.payments.filter((p) => p.currency === cur && p.draftId !== draft.id);
  const spentToday = comparable.filter((p) => SPEND_STATUSES.has(p.status) && Date.parse(p.createdAt) >= input.dayStart).reduce((a, p) => a + p.committedMinor, 0);
  const spentWeek = comparable.filter((p) => SPEND_STATUSES.has(p.status) && Date.parse(p.createdAt) >= input.weekStart).reduce((a, p) => a + p.committedMinor, 0);
  const limitsRemaining: LimitsRemaining = {
    perOrderMinor: policy.perOrderAutopayMaxMinor,
    dailyMinor: Math.max(0, policy.dailyMaxMinor - spentToday),
    weeklyMinor: Math.max(0, policy.weeklyMaxMinor - spentWeek),
    spentTodayMinor: spentToday,
    spentThisWeekMinor: spentWeek
  };

  // --- integrity: these block because the draft itself is malformed ---
  const linesValid = draft.lines.length > 0 && draft.lines.every((l) => Number.isSafeInteger(l.qty) && l.qty > 0 && isMinor(l.unitCostMinor));
  if (!linesValid || !isMinor(draft.totalMinor) || draft.totalMinor === 0) {
    add('invalid_amount', 'block', 'The order has an invalid quantity or amount, so I stopped it.');
    return finish('blocked', reasons, limitsRemaining, draft, cur);
  }
  if (draft.currency !== cur) {
    add('currency_mismatch', 'block', `The order is in ${draft.currency}, but your budget is in ${cur}.`, { draft_currency: draft.currency });
    return finish('blocked', reasons, limitsRemaining, draft, cur);
  }
  const lineTotal = draft.lines.reduce((a, l) => a + l.qty * l.unitCostMinor, 0);
  if (lineTotal !== draft.totalMinor) {
    add('total_mismatch', 'block', 'The order total does not match its lines, so I stopped it.', { lines_minor: lineTotal, total_minor: draft.totalMinor });
    return finish('blocked', reasons, limitsRemaining, draft, cur);
  }

  // --- hard rules: block ---
  if (!policy.allowListedSupplierIds.includes(draft.supplierId)) {
    add('not_allow_listed', 'block', `${draft.supplierName} is not on your approved supplier list, so I can't pay them.`);
  }
  if (!payee.hasPayee) {
    add('no_payee', 'block', `${draft.supplierName} has no PayPal account on file.`);
  } else if (!payee.verified) {
    add('payee_unverified', 'block', `${draft.supplierName}'s PayPal account isn't verified yet.`);
  }
  const fingerprint = linesFingerprint(draft.supplierId, draft.lines);
  const duplicate = comparable.find((p) => p.fingerprint === fingerprint && LIVE_STATUSES.has(p.status) && now - Date.parse(p.createdAt) < DAY_MS);
  if (duplicate) {
    add('duplicate_order', 'block', `You already ordered the same items from ${draft.supplierName} in the last 24 hours.`, { payment_id: duplicate.paymentId });
  }
  const todayAfter = spentToday + draft.totalMinor;
  const weekAfter = spentWeek + draft.totalMinor;
  if (policy.dailyHardCapMinor !== null && todayAfter > policy.dailyHardCapMinor) {
    add('over_daily_hard_cap', 'block', `This would pass your hard daily cap of ${money(policy.dailyHardCapMinor, cur)}.`, { after_minor: todayAfter });
  }
  if (policy.weeklyHardCapMinor !== null && weekAfter > policy.weeklyHardCapMinor) {
    add('over_weekly_hard_cap', 'block', `This would pass your hard weekly cap of ${money(policy.weeklyHardCapMinor, cur)}.`, { after_minor: weekAfter });
  }

  // --- soft rules: step up to the owner ---
  if (draft.totalMinor > policy.perOrderAutopayMaxMinor) {
    add('over_per_order_limit', 'step_up', `${money(draft.totalMinor, cur)} is over your ${money(policy.perOrderAutopayMaxMinor, cur)} auto-pay limit.`);
  }
  if (todayAfter > policy.dailyMaxMinor) {
    add('over_daily_budget', 'step_up', `This brings today's supplier spend to ${money(todayAfter, cur)}, over your ${money(policy.dailyMaxMinor, cur)} daily budget.`, { after_minor: todayAfter });
  }
  if (weekAfter > policy.weeklyMaxMinor) {
    add('over_weekly_budget', 'step_up', `This brings this week's supplier spend to ${money(weekAfter, cur)}, over your ${money(policy.weeklyMaxMinor, cur)} weekly budget.`, { after_minor: weekAfter });
  }
  for (const line of draft.lines) {
    const avg = averageUnitCost(history.priceHistory[line.sku] ?? [], now, 30);
    if (avg !== null) {
      const change = percentChange(avg, line.unitCostMinor);
      if (change > policy.priceJumpPct) {
        add('price_jump', 'step_up', `${line.name} went up ${change}% against the 30-day average.`, { sku: line.sku, change_pct: change, avg_minor: Math.round(avg) });
      }
    }
    const usual = usualQuantity(history.pastQuantities[line.sku] ?? []);
    if (usual !== null && line.qty > usual * policy.quantitySpikeMultiplier) {
      add('quantity_spike', 'step_up', `${line.qty} ${line.name} is more than ${policy.quantitySpikeMultiplier} times your usual ${usual}.`, { sku: line.sku, usual });
    }
  }
  if (payee.completedOrders === 0) {
    add('first_order_with_supplier', 'step_up', `This is your first paid order with ${draft.supplierName}.`);
  }
  if (!input.paymentMethodConnected) {
    add('no_payment_method', 'step_up', "PayPal isn't connected yet, so you'll approve this one in PayPal.");
  }

  const decision: PolicyDecision = reasons.some((r) => r.effect === 'block') ? 'blocked' : reasons.some((r) => r.effect === 'step_up') ? 'step_up' : 'autopay';
  if (decision === 'autopay') {
    add('within_policy', 'info', `${money(draft.totalMinor, cur)} to ${draft.supplierName} is within your rules.`);
  }
  return finish(decision, reasons, limitsRemaining, draft, cur);
}

function finish(decision: PolicyDecision, reasons: PolicyReason[], limitsRemaining: LimitsRemaining, draft: PolicyDraft, cur: string): PolicyResult {
  const amount = isMinor(draft.totalMinor) ? money(draft.totalMinor, cur) : 'this order';
  const first = reasons.find((r) => r.effect === (decision === 'blocked' ? 'block' : decision === 'step_up' ? 'step_up' : 'info'));
  const lead = decision === 'autopay'
    ? `Paying ${amount} to ${draft.supplierName}: held, not charged until delivery.`
    : decision === 'step_up'
      ? `${amount} to ${draft.supplierName} needs your OK.`
      : `I can't pay ${draft.supplierName}.`;
  const summary = decision === 'autopay' || !first ? lead : `${lead} ${first.text}`;
  return { decision, reasons, limitsRemaining, summary };
}

/**
 * Start of the current day and ISO week (Monday) in the shop's timezone, as
 * epoch ms. Pure: depends only on `now` and the IANA zone name.
 */
export function periodStarts(now: number, timeZone: string): { dayStart: number; weekStart: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const localAsUtc = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), Number(get('hour')), Number(get('minute')), Number(get('second')));
  const offset = localAsUtc - (now - (now % 1000));
  const localMidnightUtc = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
  const dayStart = localMidnightUtc - offset;
  const weekdayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { dayStart, weekStart: dayStart - Math.max(0, weekdayIndex) * DAY_MS };
}
