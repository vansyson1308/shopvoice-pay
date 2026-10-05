// 3-way match: what was ordered (the PO, from our own ledger), what the owner
// counted (the delivery), and what the supplier billed (the invoice, extracted
// from a photo). Pure and deterministic: it decides how much may be charged,
// never anything else. Invoice content is untrusted data from a photo, so it can
// only lower the charge or put the money on hold; it can never raise a charge
// above what was ordered at the PO price, add a payee, or touch the rules.

export interface PoLine {
  readonly sku: string;
  readonly name: string;
  readonly orderedQty: number;
  readonly unitCostMinor: number;
}

/** One line read from the invoice, already validated and in minor units. */
export interface InvoiceLine {
  readonly description: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface CountedLine {
  readonly sku: string;
  readonly receivedQty: number;
}

export interface ThreeWayInput {
  readonly po: readonly PoLine[];
  readonly invoice: readonly InvoiceLine[];
  /** The owner's own count. Without it the invoice quantities stand in for the count (a 2-way match). */
  readonly counted?: readonly CountedLine[] | null;
  /** Money still on hold for this order; nothing above it can be charged. */
  readonly heldMinor: number;
  /** How far an invoice unit price may sit above the PO price before the money is held (percent). */
  readonly priceTolerancePct: number;
}

export type MatchResult = 'match' | 'short' | 'over' | 'price_mismatch' | 'mismatch';
export type MatchDecision = 'full' | 'partial' | 'none' | 'hold';

export interface MatchedLine {
  readonly sku: string;
  readonly name: string;
  readonly orderedQty: number;
  readonly countedQty: number | null;
  readonly invoicedQty: number;
  readonly poUnitMinor: number;
  readonly invoiceUnitMinor: number | null;
  readonly payQty: number;
  readonly payUnitMinor: number;
  readonly payMinor: number;
  readonly notes: readonly string[];
}

export interface ThreeWayResult {
  readonly result: MatchResult;
  readonly decision: MatchDecision;
  readonly lines: readonly MatchedLine[];
  /** Invoice lines that match nothing on the order. */
  readonly unmatched: readonly InvoiceLine[];
  readonly payableMinor: number;
  readonly invoiceTotalMinor: number;
  /** What the supplier billed minus what we will pay. */
  readonly varianceMinor: number;
  /** Plain-English reasons, in order; the console shows them and the agent can speak them. */
  readonly reasons: readonly string[];
  readonly twoWay: boolean;
}

const STOP_WORDS = new Set(['the', 'of', 'and', 'cases', 'case', 'crates', 'crate', 'ct', 'pack', 'x']);

/** "milk", "whole milk crates" or a SKU against an order line. Shared with record_delivery. */
export function lineMatches(line: { readonly sku: string; readonly name: string }, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  if (line.sku.toLowerCase() === q) return true;
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const hay = line.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, '') : w);
  return words.length > 0 && words.every((w) => hay.some((h) => h.startsWith(stem(w))));
}

const UNIT_WORDS = new Set(['gal', 'gallon', 'oz', 'lb', 'lbs', 'qt', 'ct', 'count', 'dozen', 'pk']);

/**
 * How well an invoice line names an order line: an exact SKU wins outright;
 * otherwise the number of the order name's distinctive words on the line.
 */
function score(po: PoLine, line: InvoiceLine): number {
  if (line.sku && line.sku.trim().toUpperCase() === po.sku.toUpperCase()) return 1000;
  const desc = line.description.toLowerCase();
  const words = po.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !UNIT_WORDS.has(w) && !/^\d/.test(w));
  const hits = words.filter((w) => desc.includes(w.replace(/s$/, ''))).length;
  // Two distinctive words, or every word of a one-word name.
  return hits >= Math.min(2, words.length) && hits > 0 ? hits : 0;
}

/** Each invoice line goes to its best-matching order line, or to none. */
function assign(po: readonly PoLine[], invoice: readonly InvoiceLine[]): number[] {
  return invoice.map((line) => {
    let best = -1;
    let bestScore = 0;
    po.forEach((p, i) => {
      const sc = score(p, line);
      if (sc > bestScore) {
        best = i;
        bestScore = sc;
      }
    });
    return best;
  });
}

function dollars(minor: number): string {
  return `$${(minor / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export function threeWayMatch(input: ThreeWayInput): ThreeWayResult {
  const twoWay = !input.counted;
  const owner = assign(input.po, input.invoice);
  const reasons: string[] = [];
  let over = false;
  let priceHigh = false;

  const lines: MatchedLine[] = input.po.map((po, index) => {
    const mine = input.invoice.map((l, i) => ({ l, i })).filter(({ i }) => owner[i] === index);
    const invoicedQty = mine.reduce((acc, { l }) => acc + l.quantity, 0);
    const invoiceUnitMinor = mine.length > 0 ? Math.max(...mine.map(({ l }) => l.unitPriceMinor)) : null;
    const counted = input.counted?.find((c) => c.sku === po.sku);
    const countedQty = input.counted ? (counted?.receivedQty ?? 0) : null;
    const receivedQty = countedQty ?? invoicedQty;
    const notes: string[] = [];

    if (receivedQty > po.orderedQty) {
      over = true;
      notes.push(`${receivedQty} arrived but ${po.orderedQty} were ordered`);
    }
    if (invoiceUnitMinor !== null && invoiceUnitMinor * 100 > po.unitCostMinor * (100 + input.priceTolerancePct)) {
      priceHigh = true;
      notes.push(`billed at ${dollars(invoiceUnitMinor)} each, ordered at ${dollars(po.unitCostMinor)}`);
    }
    if (countedQty !== null && invoicedQty > countedQty) notes.push(`billed for ${invoicedQty}, counted ${countedQty}; paying for ${countedQty}`);
    if (countedQty !== null && mine.length === 0 && countedQty > 0) notes.push('not on the invoice; paying for what was counted');

    // Pay for what arrived, never more than ordered, never more than billed, at the lower of the two prices.
    const billedCap = mine.length > 0 ? invoicedQty : receivedQty;
    const payQty = Math.max(0, Math.min(po.orderedQty, receivedQty, billedCap));
    const payUnitMinor = invoiceUnitMinor === null ? po.unitCostMinor : Math.min(po.unitCostMinor, invoiceUnitMinor);
    if (invoiceUnitMinor !== null && invoiceUnitMinor < po.unitCostMinor) notes.push(`billed below the order price; paying ${dollars(invoiceUnitMinor)} each`);
    return {
      sku: po.sku, name: po.name, orderedQty: po.orderedQty, countedQty, invoicedQty,
      poUnitMinor: po.unitCostMinor, invoiceUnitMinor, payQty, payUnitMinor, payMinor: payQty * payUnitMinor, notes
    };
  });

  const unmatched = input.invoice.filter((_, i) => owner[i] === -1);
  const invoiceTotalMinor = input.invoice.reduce((acc, l) => acc + l.quantity * l.unitPriceMinor, 0);
  const rawPayable = lines.reduce((acc, l) => acc + l.payMinor, 0);
  const payableMinor = Math.min(rawPayable, Math.max(0, input.heldMinor));

  let result: MatchResult;
  let decision: MatchDecision;
  if (unmatched.length > 0) {
    result = 'mismatch';
    decision = 'hold';
    reasons.push(`The invoice has ${unmatched.length === 1 ? 'a line' : `${unmatched.length} lines`} that ${unmatched.length === 1 ? 'is' : 'are'} not on your order (${unmatched.map((l) => l.description.slice(0, 40)).join(', ')}). Holding the money until you check it.`);
  } else if (over) {
    result = 'over';
    decision = 'hold';
    reasons.push('More arrived than you ordered. Holding the money until you check it.');
  } else if (priceHigh) {
    result = 'price_mismatch';
    decision = 'hold';
    reasons.push(`The invoice price is more than ${input.priceTolerancePct}% above your order. Holding the money until you check it.`);
  } else {
    const fullValue = lines.reduce((acc, l) => acc + l.orderedQty * l.poUnitMinor, 0);
    result = rawPayable >= fullValue && lines.every((l) => l.payQty === l.orderedQty) ? 'match' : 'short';
    decision = payableMinor === 0 ? 'none' : payableMinor >= input.heldMinor ? 'full' : 'partial';
    reasons.push(result === 'match' ? 'Order, delivery and invoice agree.' : `Paying ${dollars(payableMinor)} for what arrived; the rest of the hold is released.`);
  }
  if (twoWay && decision !== 'hold') reasons.push('No count was entered, so the invoice quantities were used as the count.');
  for (const l of lines) for (const n of l.notes) reasons.push(`${l.name}: ${n}.`);

  return {
    result, decision, lines, unmatched, payableMinor: decision === 'hold' ? 0 : payableMinor, invoiceTotalMinor,
    varianceMinor: invoiceTotalMinor - (decision === 'hold' ? 0 : payableMinor), reasons, twoWay
  };
}
