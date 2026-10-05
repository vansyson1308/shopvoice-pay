// The supplier-payment state machine. Pure: (state, action) -> new state, or
// a LedgerError and no change. Every money movement the server makes is first
// checked here, then mirrored by PayPal, then persisted (the database enforces
// the same invariants as CHECK constraints, migration 019).
//
// Invariants (property-tested):
//   captured + voided <= authorized <= requested
//   refunded <= captured
//   settled  <= captured
//
// Status is what the owner sees: held (authorized), charged (captured),
// partially charged (partially_captured), voided, refunded.

export type PaymentStatus = 'pending_approval' | 'authorized' | 'partially_captured' | 'captured' | 'voided' | 'refunded' | 'failed' | 'blocked';

export interface MoneyState {
  readonly status: PaymentStatus;
  readonly requestedMinor: number;
  readonly authorizedMinor: number;
  readonly capturedMinor: number;
  readonly voidedMinor: number;
  readonly refundedMinor: number;
  readonly settledMinor: number;
}

export type LedgerAction =
  | { readonly kind: 'authorize'; readonly amountMinor: number }
  | { readonly kind: 'capture'; readonly amountMinor: number; readonly final: boolean }
  | { readonly kind: 'void' }
  | { readonly kind: 'refund'; readonly amountMinor: number }
  | { readonly kind: 'settle'; readonly amountMinor: number }
  | { readonly kind: 'decline' }
  | { readonly kind: 'fail' };

export class LedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function newPaymentState(requestedMinor: number, status: 'pending_approval' | 'blocked'): MoneyState {
  if (!Number.isSafeInteger(requestedMinor) || requestedMinor <= 0) throw new LedgerError('invalid_amount', 'requested amount must be a positive integer');
  return { status, requestedMinor, authorizedMinor: 0, capturedMinor: 0, voidedMinor: 0, refundedMinor: 0, settledMinor: 0 };
}

/** Authorized money that is still held: neither captured nor released. */
export function heldMinor(s: MoneyState): number {
  return s.authorizedMinor - s.capturedMinor - s.voidedMinor;
}

/** Money currently charged to the shop (captured minus refunded). */
export function chargedMinor(s: MoneyState): number {
  return s.capturedMinor - s.refundedMinor;
}

/** Money the policy counts against budgets: held plus charged. */
export function committedMinor(s: MoneyState): number {
  return heldMinor(s) + chargedMinor(s);
}

function positive(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new LedgerError('invalid_amount', 'amount must be a positive integer number of minor units');
}

function require(cond: boolean, code: string, message: string): void {
  if (!cond) throw new LedgerError(code, message);
}

export function applyAction(s: MoneyState, action: LedgerAction): MoneyState {
  switch (action.kind) {
    case 'authorize': {
      positive(action.amountMinor);
      require(s.status === 'pending_approval', 'invalid_transition', `cannot authorize a ${s.status} payment`);
      require(action.amountMinor <= s.requestedMinor, 'over_requested', 'cannot authorize more than was requested');
      return { ...s, status: 'authorized', authorizedMinor: action.amountMinor };
    }
    case 'capture': {
      positive(action.amountMinor);
      require(s.status === 'authorized' || s.status === 'partially_captured', 'invalid_transition', `cannot capture a ${s.status} payment`);
      const held = heldMinor(s);
      require(held > 0, 'nothing_held', 'nothing left to capture');
      require(action.amountMinor <= held, 'over_capture', 'cannot capture more than is held');
      const captured = s.capturedMinor + action.amountMinor;
      const remainder = held - action.amountMinor;
      // final_capture releases the remainder (sandbox-confirmed, SPIKE S2.5/S2.8).
      const voided = action.final ? s.voidedMinor + remainder : s.voidedMinor;
      // Fully charged only when everything authorized was captured; otherwise
      // the owner sees "partially charged" (still open, or closed short).
      const status: PaymentStatus = captured === s.authorizedMinor ? 'captured' : 'partially_captured';
      return { ...s, status, capturedMinor: captured, voidedMinor: voided };
    }
    case 'void': {
      require(s.status === 'authorized' || s.status === 'partially_captured', 'invalid_transition', `cannot void a ${s.status} payment`);
      const held = heldMinor(s);
      require(held > 0, 'nothing_held', 'nothing left to void');
      return { ...s, status: s.capturedMinor === 0 ? 'voided' : 'partially_captured', voidedMinor: s.voidedMinor + held };
    }
    case 'refund': {
      positive(action.amountMinor);
      const closedCharge = (s.status === 'captured' || s.status === 'partially_captured' || s.status === 'refunded') && heldMinor(s) === 0;
      require(closedCharge, 'invalid_transition', 'refunds apply after the delivery has been settled (nothing still held)');
      require(action.amountMinor <= chargedMinor(s), 'over_refund', 'cannot refund more than was charged');
      const refunded = s.refundedMinor + action.amountMinor;
      return { ...s, status: refunded === s.capturedMinor ? 'refunded' : s.status, refundedMinor: refunded };
    }
    case 'settle': {
      positive(action.amountMinor);
      require(s.status === 'captured' || s.status === 'partially_captured' || s.status === 'refunded', 'invalid_transition', `cannot settle a ${s.status} payment`);
      require(heldMinor(s) === 0, 'still_held', 'settle only after the delivery is closed');
      require(s.settledMinor + action.amountMinor <= chargedMinor(s), 'over_settle', 'cannot pay the supplier more than the shop was charged');
      return { ...s, settledMinor: s.settledMinor + action.amountMinor };
    }
    case 'decline': {
      require(s.status === 'pending_approval', 'invalid_transition', `cannot decline a ${s.status} payment`);
      return { ...s, status: 'voided' };
    }
    case 'fail': {
      require(s.status === 'pending_approval', 'invalid_transition', `cannot fail a ${s.status} payment once money moved`);
      return { ...s, status: 'failed' };
    }
  }
}

export function checkInvariants(s: MoneyState): string[] {
  const broken: string[] = [];
  const values = [s.requestedMinor, s.authorizedMinor, s.capturedMinor, s.voidedMinor, s.refundedMinor, s.settledMinor];
  if (!values.every((v) => Number.isSafeInteger(v) && v >= 0)) broken.push('non-negative integers');
  if (s.authorizedMinor > s.requestedMinor) broken.push('authorized <= requested');
  if (s.capturedMinor + s.voidedMinor > s.authorizedMinor) broken.push('captured + voided <= authorized');
  if (s.refundedMinor > s.capturedMinor) broken.push('refunded <= captured');
  if (s.settledMinor > s.capturedMinor) broken.push('settled <= captured');
  return broken;
}

/** New order lines (an accepted substitution) may only replace lines on a held, uncharged payment, within the hold. */
export function assertLineSwap(current: MoneyState & { readonly status: PaymentStatus }, lines: readonly { readonly qty: number; readonly unitCostMinor: number }[]): void {
  if (current.status !== 'authorized' || current.capturedMinor !== 0) throw new LedgerError('lines_locked', 'Order lines can only change while the money is held and nothing was charged');
  if (lines.length === 0 || lines.some((l) => !Number.isSafeInteger(l.qty) || l.qty <= 0 || !Number.isSafeInteger(l.unitCostMinor) || l.unitCostMinor < 0)) {
    throw new LedgerError('invalid_lines', 'Order lines must have positive quantities and prices');
  }
  const total = lines.reduce((acc, l) => acc + l.qty * l.unitCostMinor, 0);
  if (total > current.authorizedMinor) throw new LedgerError('over_hold', 'New order lines cost more than the money on hold');
}
